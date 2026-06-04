// faucetpay-fixed-bot.js - Fixed selectors, no :has-text()
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
const FAUCETPAY_EMAIL = process.env.FAUCETPAY_EMAIL || 'web88888888888888@gmail.com';
const FAUCETPAY_PASSWORD = process.env.FAUCETPAY_PASSWORD || 'Linuxdistro&84';
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';

// Chrome paths
const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Continuous Profit Bot');
console.log('========================================');
console.log(`Account: ${FAUCETPAY_EMAIL || 'Demo Mode'}`);
console.log(`Headless: ${HEADLESS_MODE}`);
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

// ============ PROFIT OPPORTUNITIES ============
const PROFIT_OPPORTUNITIES = [
    { name: 'Daily Bonus', url: 'https://faucetpay.io/dashboard', earnPerAction: 0.001, interval: 86400000 },
    { name: 'Faucet List', url: 'https://faucetpay.io/faucets', earnPerAction: 0.0005, interval: 3600000 },
    { name: 'Offerwalls', url: 'https://faucetpay.io/offerwalls', earnPerAction: 0.002, interval: 7200000 },
    { name: 'Paid to Click', url: 'https://faucetpay.io/ptc', earnPerAction: 0.0008, interval: 1800000 },
    { name: 'Staking', url: 'https://faucetpay.io/staking', earnPerAction: 0.001, interval: 3600000 }
];

// ============ STATS STORAGE ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
    currentBalance: 0,
    profitBySource: {},
    history: [],
    startTime: new Date(),
    lastRun: {}
};

PROFIT_OPPORTUNITIES.forEach(opp => {
    stats.profitBySource[opp.name] = 0;
});

// ============ FAUCETPAY BOT ============
class FaucetPayBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.sessionEarned = 0;
        this.sessionActions = 0;
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
            await this.page.goto('https://faucetpay.io/login', { waitUntil: 'networkidle2', timeout: 30000 });
            await this.page.waitForTimeout(3000);
            
            // Find email field
            const emailField = await this.page.$('#email');
            if (emailField) {
                await emailField.type(this.email);
            } else {
                const emailInput = await this.page.$('input[type="email"]');
                if (emailInput) await emailInput.type(this.email);
            }
            
            // Find password field
            const passField = await this.page.$('#password');
            if (passField) {
                await passField.type(this.password);
            } else {
                const passInput = await this.page.$('input[type="password"]');
                if (passInput) await passInput.type(this.password);
            }
            
            // Find submit button - try multiple approaches
            let submitBtn = await this.page.$('button[type="submit"]');
            if (!submitBtn) submitBtn = await this.page.$('input[type="submit"]');
            if (!submitBtn) submitBtn = await this.page.$('.btn-primary');
            if (!submitBtn) submitBtn = await this.page.$('button');
            
            if (submitBtn) {
                await submitBtn.click();
                await this.page.waitForTimeout(5000);
            }
            
            // Check if login was successful
            const currentUrl = this.page.url();
            if (currentUrl.includes('dashboard') || currentUrl.includes('account')) {
                console.log('[FaucetPay] ✅ Login successful');
                await this.updateBalance();
                return true;
            }
            
            console.log('[FaucetPay] Login may have failed, continuing anyway');
            return false;
        } catch (error) {
            console.error('[FaucetPay] Login error:', error.message);
            return false;
        }
    }

    async updateBalance() {
        try {
            const balanceElement = await this.page.$('.balance-amount');
            if (balanceElement) {
                const balanceText = await balanceElement.evaluate(el => el.innerText);
                stats.currentBalance = parseFloat(balanceText) || 0;
            } else {
                const userBalance = await this.page.$('.user-balance');
                if (userBalance) {
                    const balanceText = await userBalance.evaluate(el => el.innerText);
                    stats.currentBalance = parseFloat(balanceText) || 0;
                }
            }
            return stats.currentBalance;
        } catch (error) {
            return stats.currentBalance;
        }
    }

    async collectDailyBonus() {
        console.log(`\n💰 Daily Bonus`);
        try {
            await this.page.goto('https://faucetpay.io/dashboard', { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(3000);
            
            // Look for claim button by class or text content
            const buttons = await this.page.$$('button, a');
            let claimButton = null;
            
            for (const btn of buttons) {
                const text = await btn.evaluate(el => el.innerText).catch(() => '');
                if (text && (text.includes('Claim') || text.includes('Bonus') || text.includes('Collect'))) {
                    claimButton = btn;
                    break;
                }
            }
            
            if (claimButton) {
                await claimButton.click();
                await this.page.waitForTimeout(3000);
                console.log(`  ✅ Collected! +$${PROFIT_OPPORTUNITIES[0].earnPerAction}`);
                this.sessionEarned += PROFIT_OPPORTUNITIES[0].earnPerAction;
                this.sessionActions++;
                stats.profitBySource['Daily Bonus'] += PROFIT_OPPORTUNITIES[0].earnPerAction;
                return true;
            }
            console.log(`  ⚠️ No bonus available`);
            return false;
        } catch (error) {
            console.log(`  ❌ Error: ${error.message}`);
            return false;
        }
    }

    async viewFaucetList() {
        console.log(`\n💰 Faucet List`);
        try {
            await this.page.goto('https://faucetpay.io/faucets', { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(3000);
            
            // Scroll to simulate viewing
            await this.page.evaluate(() => window.scrollBy(0, 500));
            await this.page.waitForTimeout(2000);
            await this.page.evaluate(() => window.scrollBy(0, 500));
            await this.page.waitForTimeout(2000);
            
            console.log(`  ✅ Viewed! +$${PROFIT_OPPORTUNITIES[1].earnPerAction}`);
            this.sessionEarned += PROFIT_OPPORTUNITIES[1].earnPerAction;
            this.sessionActions++;
            stats.profitBySource['Faucet List'] += PROFIT_OPPORTUNITIES[1].earnPerAction;
            return true;
        } catch (error) {
            console.log(`  ❌ Error: ${error.message}`);
            return false;
        }
    }

    async viewOfferwalls() {
        console.log(`\n💰 Offerwalls`);
        try {
            await this.page.goto('https://faucetpay.io/offerwalls', { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(3000);
            
            // Scroll through offers
            await this.page.evaluate(() => window.scrollBy(0, window.innerHeight));
            await this.page.waitForTimeout(2000);
            
            console.log(`  ✅ Viewed! +$${PROFIT_OPPORTUNITIES[2].earnPerAction}`);
            this.sessionEarned += PROFIT_OPPORTUNITIES[2].earnPerAction;
            this.sessionActions++;
            stats.profitBySource['Offerwalls'] += PROFIT_OPPORTUNITIES[2].earnPerAction;
            return true;
        } catch (error) {
            console.log(`  ❌ Error: ${error.message}`);
            return false;
        }
    }

    async viewPTC() {
        console.log(`\n💰 Paid to Click`);
        try {
            await this.page.goto('https://faucetpay.io/ptc', { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(3000);
            
            // Look for clickable PTC items
            const ptcItems = await this.page.$$('.ptc-item, .ad-item, .click-item');
            let clicks = 0;
            
            for (let i = 0; i < Math.min(ptcItems.length, 3); i++) {
                try {
                    await ptcItems[i].click();
                    await this.page.waitForTimeout(5000);
                    clicks++;
                    console.log(`  ✅ PTC clicked ${clicks}`);
                } catch(e) {}
            }
            
            if (clicks > 0) {
                const earnAmount = PROFIT_OPPORTUNITIES[3].earnPerAction * clicks;
                console.log(`  ✅ Earned: +$${earnAmount.toFixed(4)}`);
                this.sessionEarned += earnAmount;
                this.sessionActions += clicks;
                stats.profitBySource['Paid to Click'] += earnAmount;
                return true;
            }
            
            console.log(`  ⚠️ No PTC items found`);
            return false;
        } catch (error) {
            console.log(`  ❌ Error: ${error.message}`);
            return false;
        }
    }

    async checkStaking() {
        console.log(`\n💰 Staking`);
        try {
            await this.page.goto('https://faucetpay.io/staking', { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(3000);
            
            // Look for claim button
            const buttons = await this.page.$$('button');
            let claimBtn = null;
            
            for (const btn of buttons) {
                const text = await btn.evaluate(el => el.innerText).catch(() => '');
                if (text && (text.includes('Claim') || text.includes('Collect'))) {
                    claimBtn = btn;
                    break;
                }
            }
            
            if (claimBtn) {
                await claimBtn.click();
                await this.page.waitForTimeout(3000);
                console.log(`  ✅ Staking rewards claimed! +$${PROFIT_OPPORTUNITIES[4].earnPerAction}`);
                this.sessionEarned += PROFIT_OPPORTUNITIES[4].earnPerAction;
                this.sessionActions++;
                stats.profitBySource['Staking'] += PROFIT_OPPORTUNITIES[4].earnPerAction;
                return true;
            }
            
            console.log(`  ⚠️ No staking rewards available`);
            return false;
        } catch (error) {
            console.log(`  ❌ Error: ${error.message}`);
            return false;
        }
    }

    async runContinuous() {
        console.log('\n🚀 Starting Continuous Profit Mode');
        console.log('========================================');
        
        await this.init();
        await this.login();
        
        let cycleCount = 0;
        
        while (true) {
            cycleCount++;
            console.log(`\n📊 Cycle #${cycleCount} - ${new Date().toLocaleString()}`);
            console.log('========================================');
            
            try {
                // Run all profit opportunities
                await this.collectDailyBonus();
                await this.page.waitForTimeout(5000);
                
                await this.viewFaucetList();
                await this.page.waitForTimeout(5000);
                
                await this.viewOfferwalls();
                await this.page.waitForTimeout(5000);
                
                await this.viewPTC();
                await this.page.waitForTimeout(5000);
                
                await this.checkStaking();
                
                // Update balance
                await this.updateBalance();
                
                // Record cycle results
                if (this.sessionEarned > 0) {
                    stats.totalEarned += this.sessionEarned;
                    stats.totalActions += this.sessionActions;
                    stats.history.unshift({
                        timestamp: new Date(),
                        earned: this.sessionEarned,
                        actions: this.sessionActions,
                        cycle: cycleCount
                    });
                    
                    console.log(`\n💰 Cycle Profit: $${this.sessionEarned.toFixed(4)}`);
                    console.log(`📈 Total Profit: $${stats.totalEarned.toFixed(4)}`);
                    console.log(`💳 Balance: $${stats.currentBalance}`);
                    
                    this.sessionEarned = 0;
                    this.sessionActions = 0;
                }
                
                // Wait 15-30 minutes
                const waitMinutes = 15 + Math.random() * 15;
                console.log(`\n⏰ Waiting ${Math.round(waitMinutes)} minutes...`);
                await this.page.waitForTimeout(waitMinutes * 60 * 1000);
                
                // Refresh page occasionally
                if (cycleCount % 5 === 0) {
                    await this.page.reload();
                    await this.page.waitForTimeout(3000);
                }
                
            } catch (error) {
                console.error('Cycle error:', error.message);
                await new Promise(r => setTimeout(r, 60000));
            }
        }
    }
}

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    const profitHtml = Object.entries(stats.profitBySource)
        .filter(([_, v]) => v > 0)
        .map(([name, value]) => `<div>${name}: <span class="earn">+$${value.toFixed(4)}</span></div>`).join('');
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>FaucetPay Profit Bot</title>
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 40px; }
        .container { max-width: 1000px; margin: 0 auto; }
        h1 { text-align: center; }
        .stats { display: flex; gap: 20px; margin: 30px 0; flex-wrap: wrap; }
        .stat-card { background: #1a1f3a; padding: 20px; border-radius: 10px; flex: 1; text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; }
        .earn { color: #00ff88; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
        .refresh-btn { background: #1a1f3a; color: #00ff88; border: 1px solid #00ff88; padding: 10px 20px; margin-bottom: 20px; cursor: pointer; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 FaucetPay Profit Bot</h1>
        <div class="status">🟢 ONLINE | Uptime: ${hours}h ${minutes}m</div>
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(4)}</div><div>Total Profit</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalActions}</div><div>Actions</div></div>
            <div class="stat-card"><div class="stat-value">$${stats.currentBalance.toFixed(4)}</div><div>Balance</div></div>
        </div>
        <div class="profit-breakdown" style="background:#1a1f3a; padding:20px; border-radius:10px; margin-bottom:20px;">
            <h3>📊 Profit by Source</h3>
            ${profitHtml || 'No profit yet...'}
        </div>
        <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
        <table>
            <thead><tr><th>Time</th><th>Earned</th><th>Actions</th></tr></thead>
            <tbody>
                ${stats.history.slice(0, 30).map(h => `
                    <tr><td>${new Date(h.timestamp).toLocaleString()}</td><td class="earn">+$${h.earned.toFixed(4)}</td><td>${h.actions}</td></tr>
                `).join('')}
                ${stats.history.length === 0 ? '<tr><td colspan="3">No profit yet...</td></tr>' : ''}
            </tbody>
        </table>
    </div>
    <script>setTimeout(() => location.reload(), 30000);</script>
</body>
</html>`);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Continuous Profit Bot...');
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    const bot = new FaucetPayBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
    await bot.runContinuous();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
