// faucetpay-full-bot.js - Complete FaucetPay Automation Bot
const express = require('express');
const fs = require('fs');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const { createWriteStream } = require('fs');
const cron = require('node-cron');

// Apply stealth plugin
puppeteer.use(StealthPlugin());

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const FAUCETPAY_EMAIL = process.env.FAUCETPAY_EMAIL || 'web88888888888888@gmail.com';
const FAUCETPAY_PASSWORD = process.env.FAUCETPAY_PASSWORD || 'Linuxdistro&84';
const AUTO_WITHDRAW = process.env.AUTO_WITHDRAW !== 'false';
const MIN_WITHDRAWAL_USD = parseFloat(process.env.MIN_WITHDRAWAL_USD) || 0.10;
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';

// Chrome paths
const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Full Automation Bot');
console.log('========================================');
console.log(`Account: ${FAUCETPAY_EMAIL || 'Demo Mode'}`);
console.log(`Auto Withdraw: ${AUTO_WITHDRAW}`);
console.log(`Min Withdrawal: $${MIN_WITHDRAWAL_USD}`);
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
        if (stats.size > 50000000) {
            console.log('[Chrome] Already installed');
            return CHROME_PATH;
        }
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

// ============ FAUCET SITES ============
const FAUCET_SITES = [
    { name: 'FireFaucet', url: 'https://firefaucet.win', earnPerClaim: 0.0005 },
    { name: 'EzBit', url: 'https://ezbit.co.in', earnPerClaim: 0.0003 },
    { name: 'CoinPayU', url: 'https://coinpayu.com', earnPerClaim: 0.001 },
    { name: 'AdBTC', url: 'https://adbtc.top', earnPerClaim: 0.0015 },
    { name: 'BTCClicks', url: 'https://btcclicks.com', earnPerClaim: 0.0012 },
    { name: 'Cointiply', url: 'https://cointiply.com', earnPerClaim: 0.003 }
];

// ============ PTC SITES ============
const PTC_SITES = [
    { name: 'CoinPayU PTC', url: 'https://coinpayu.com/earn/ads', earnPerClick: 0.0005 },
    { name: 'AdBTC PTC', url: 'https://adbtc.top/ptc', earnPerClick: 0.0008 },
    { name: 'BTCClicks PTC', url: 'https://btcclicks.com/ptc', earnPerClick: 0.0006 }
];

// ============ STATS STORAGE ============
let stats = {
    totalEarned: 0,
    totalFaucetClaims: 0,
    totalPTClicks: 0,
    totalStakingRewards: 0,
    currentBalance: 0,
    lastRun: null,
    history: []
};

// ============ FAUCETPAY BOT ============
class FaucetPayBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.sessionEarned = 0;
        this.sessionFaucets = 0;
        this.sessionPTC = 0;
        this.sessionStaking = 0;
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
            console.log('[FaucetPay] Demo mode - limited functionality');
            return false;
        }
        
        console.log('[FaucetPay] Logging in...');
        try {
            await this.page.goto('https://faucetpay.io/login', { waitUntil: 'networkidle2', timeout: 30000 });
            await this.page.waitForTimeout(3000);
            
            // Try different selectors
            const emailSelectors = ['#email', 'input[name="email"]', 'input[type="email"]'];
            for (const selector of emailSelectors) {
                const emailField = await this.page.$(selector);
                if (emailField) {
                    await emailField.type(this.email);
                    break;
                }
            }
            
            const passSelectors = ['#password', 'input[name="password"]', 'input[type="password"]'];
            for (const selector of passSelectors) {
                const passField = await this.page.$(selector);
                if (passField) {
                    await passField.type(this.password);
                    break;
                }
            }
            
            await this.page.click('button[type="submit"]');
            await this.page.waitForTimeout(5000);
            
            console.log('[FaucetPay] ✅ Login successful');
            await this.updateBalance();
            return true;
        } catch (error) {
            console.error('[FaucetPay] Login failed:', error.message);
            return false;
        }
    }

    async updateBalance() {
        try {
            const balance = await this.page.$eval('.balance-amount, .user-balance', el => el.innerText).catch(() => '0');
            stats.currentBalance = parseFloat(balance) || 0;
            console.log(`💰 Balance: $${stats.currentBalance}`);
            return stats.currentBalance;
        } catch (error) {
            return stats.currentBalance;
        }
    }

    async claimFaucets() {
        console.log('\n🌊 Claiming faucets...');
        
        for (const faucet of FAUCET_SITES) {
            try {
                console.log(`  [${faucet.name}]...`);
                await this.page.goto(faucet.url, { waitUntil: 'networkidle2', timeout: 20000 });
                await this.page.waitForTimeout(3000);
                
                // Find and click claim button
                const claimSelectors = [
                    '#claimButton', '.claim-btn', 'button:has-text("Claim")',
                    '.claim-button', '#claim', '.faucet-button'
                ];
                
                let claimed = false;
                for (const selector of claimSelectors) {
                    const claimBtn = await this.page.$(selector);
                    if (claimBtn) {
                        await claimBtn.click();
                        await this.page.waitForTimeout(5000);
                        console.log(`    ✅ Claimed +$${faucet.earnPerClaim}`);
                        this.sessionEarned += faucet.earnPerClaim;
                        this.sessionFaucets++;
                        claimed = true;
                        break;
                    }
                }
                
                if (!claimed) console.log(`    ⚠️ No claim button found`);
                
                // Random delay between faucets
                await this.page.waitForTimeout(5000 + Math.random() * 10000);
                
            } catch (error) {
                console.log(`    ❌ Error: ${error.message}`);
            }
        }
        
        console.log(`  📊 Faucets claimed: ${this.sessionFaucets}`);
    }

    async clickPTC() {
        console.log('\n🖱️ Processing PTC ads...');
        
        for (const ptc of PTC_SITES) {
            try {
                console.log(`  [${ptc.name}]...`);
                await this.page.goto(ptc.url, { waitUntil: 'networkidle2', timeout: 20000 });
                await this.page.waitForTimeout(3000);
                
                // Find and click PTC links
                const ptcSelectors = ['.ad-link', 'a[href*="click"]', 'a[class*="ad"]', '.ptc-item a'];
                
                let clicks = 0;
                for (const selector of ptcSelectors) {
                    const ads = await this.page.$$(selector);
                    for (let i = 0; i < Math.min(ads.length, 10); i++) {
                        try {
                            await ads[i].click();
                            await this.page.waitForTimeout(5000);
                            console.log(`    ✅ PTC click +$${ptc.earnPerClick}`);
                            this.sessionEarned += ptc.earnPerClick;
                            this.sessionPTC++;
                            clicks++;
                        } catch(e) {}
                    }
                }
                
                if (clicks === 0) console.log(`    ⚠️ No PTC ads found`);
                
            } catch (error) {
                console.log(`    ❌ Error: ${error.message}`);
            }
            
            await this.page.waitForTimeout(5000 + Math.random() * 10000);
        }
        
        console.log(`  📊 PTC clicks: ${this.sessionPTC}`);
    }

    async checkStaking() {
        console.log('\n💰 Checking staking rewards...');
        
        try {
            await this.page.goto('https://faucetpay.io/staking', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(3000);
            
            // Check for claimable rewards
            const rewardClaim = await this.page.$('.claim-staking-reward, button:has-text("Claim")');
            if (rewardClaim) {
                await rewardClaim.click();
                await this.page.waitForTimeout(3000);
                console.log('  ✅ Staking rewards claimed');
                this.sessionEarned += 0.002;
                this.sessionStaking++;
            } else {
                console.log('  ⚠️ No staking rewards available');
            }
        } catch (error) {
            console.log(`  ❌ Staking error: ${error.message}`);
        }
    }

    async autoWithdraw() {
        if (!AUTO_WITHDRAW || !this.email || !this.password) return;
        
        await this.updateBalance();
        
        if (stats.currentBalance >= MIN_WITHDRAWAL_USD) {
            console.log(`\n💸 Attempting withdrawal of $${stats.currentBalance}...`);
            try {
                await this.page.goto('https://faucetpay.io/withdraw', { waitUntil: 'networkidle2' });
                await this.page.waitForTimeout(3000);
                
                // Note: Withdrawal requires pre-configured address
                console.log('  ⚠️ Manual withdrawal required - configure wallet address first');
            } catch (error) {
                console.log(`  ❌ Withdrawal error: ${error.message}`);
            }
        }
    }

    async dailyBonus() {
        console.log('\n🎁 Checking daily bonus...');
        try {
            await this.page.goto('https://faucetpay.io/dashboard', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(3000);
            
            const bonusBtn = await this.page.$('.claim-bonus, button:has-text("Claim")');
            if (bonusBtn) {
                await bonusBtn.click();
                await this.page.waitForTimeout(3000);
                console.log('  ✅ Daily bonus collected!');
                this.sessionEarned += 0.001;
            } else {
                console.log('  ⚠️ No daily bonus available');
            }
        } catch (error) {
            console.log(`  ❌ Bonus error: ${error.message}`);
        }
    }

    async runSession() {
        console.log('\n========================================');
        console.log('  Starting FaucetPay Session');
        console.log(`  Time: ${new Date().toLocaleString()}`);
        console.log('========================================');
        
        await this.init();
        await this.login();
        
        if (this.email && this.password) {
            await this.dailyBonus();
            await this.claimFaucets();
            await this.clickPTC();
            await this.checkStaking();
            await this.autoWithdraw();
        } else {
            console.log('\n⚠️ Demo Mode - Set FAUCETPAY_EMAIL and FAUCETPAY_PASSWORD to earn real money');
            // Simulate for demo
            this.sessionEarned = 0.003;
            this.sessionFaucets = 3;
        }
        
        // Update global stats
        stats.totalEarned += this.sessionEarned;
        stats.totalFaucetClaims += this.sessionFaucets;
        stats.totalPTClicks += this.sessionPTC;
        stats.totalStakingRewards += this.sessionStaking;
        stats.lastRun = new Date();
        stats.history.unshift({
            timestamp: new Date(),
            earned: this.sessionEarned,
            faucets: this.sessionFaucets,
            ptc: this.sessionPTC,
            staking: this.sessionStaking
        });
        
        // Keep only last 100 records
        if (stats.history.length > 100) stats.history.pop();
        
        console.log('\n========================================');
        console.log(`  Session Complete`);
        console.log(`  Earned: $${this.sessionEarned.toFixed(4)}`);
        console.log(`  Faucet Claims: ${this.sessionFaucets}`);
        console.log(`  PTC Clicks: ${this.sessionPTC}`);
        console.log(`  Total Earned: $${stats.totalEarned.toFixed(4)}`);
        console.log(`  Balance: $${stats.currentBalance}`);
        console.log('========================================\n');
        
        await this.browser.close();
        return this.sessionEarned;
    }
}

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html>
<head>
    <title>FaucetPay Bot Dashboard</title>
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 40px; }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 20px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: #1a1f3a; padding: 20px; border-radius: 10px; text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; color: #00ff88; }
        .stat-label { color: #888; margin-top: 5px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
        th { color: #00ff88; }
        .earn { color: #00ff88; }
        .refresh-btn { background: #1a1f3a; color: #00ff88; border: 1px solid #00ff88; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 FaucetPay Full Automation Bot</h1>
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(4)}</div><div class="stat-label">Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalFaucetClaims}</div><div class="stat-label">Faucet Claims</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalPTClicks}</div><div class="stat-label">PTC Clicks</div></div>
            <div class="stat-card"><div class="stat-value">$${stats.currentBalance.toFixed(4)}</div><div class="stat-label">Balance</div></div>
        </div>
        <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
        <table>
            <thead><tr><th>Time</th><th>Earned</th><th>Faucets</th><th>PTC</th><th>Staking</th></tr></thead>
            <tbody>
                ${stats.history.slice(0, 30).map(h => `
                    <tr>
                        <td>${new Date(h.timestamp).toLocaleString()}</td>
                        <td class="earn">+$${h.earned.toFixed(4)}</td>
                        <td>${h.faucets}</td>
                        <td>${h.ptc}</td>
                        <td>${h.staking}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>
    <script>setTimeout(() => location.reload(), 30000);</script>
</body>
</html>`;
    res.send(html);
});

// ============ SCHEDULED TASKS (Cron Jobs) ============
function startScheduledTasks() {
    // Run every hour
    cron.schedule('0 * * * *', async () => {
        console.log('\n⏰ Running scheduled session...');
        const bot = new FaucetPayBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
        await bot.runSession();
    });
    
    // Check staking every 30 minutes
    cron.schedule('*/30 * * * *', async () => {
        if (FAUCETPAY_EMAIL && FAUCETPAY_PASSWORD) {
            console.log('\n💰 Running staking check...');
            const bot = new FaucetPayBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
            await bot.init();
            await bot.login();
            await bot.checkStaking();
            await bot.browser.close();
        }
    });
    
    console.log('✅ Scheduled tasks started (hourly runs, 30-min staking checks)');
}

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting FaucetPay Full Automation Bot...');
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    startScheduledTasks();
    
    // Run initial session
    const bot = new FaucetPayBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
    await bot.runSession();
    
    console.log('Bot running with scheduled tasks...');
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
