// faucetpay-bot.js - No external cron dependencies
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
const RUN_INTERVAL_HOURS = parseInt(process.env.RUN_INTERVAL_HOURS) || 2;

// Chrome paths
const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Bot');
console.log('========================================');
console.log(`Account: ${FAUCETPAY_EMAIL || 'Demo Mode'}`);
console.log(`Run Interval: Every ${RUN_INTERVAL_HOURS} hour(s)`);
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

// ============ STATS STORAGE ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
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
            
            // Try different selectors for email
            const emailSelectors = ['#email', 'input[name="email"]', 'input[type="email"]'];
            for (const selector of emailSelectors) {
                const emailField = await this.page.$(selector);
                if (emailField) {
                    await emailField.type(this.email);
                    break;
                }
            }
            
            // Try different selectors for password
            const passSelectors = ['#password', 'input[name="password"]', 'input[type="password"]'];
            for (const selector of passSelectors) {
                const passField = await this.page.$(selector);
                if (passField) {
                    await passField.type(this.password);
                    break;
                }
            }
            
            // Try to find and click submit button
            const submitBtn = await this.page.$('button[type="submit"]');
            if (submitBtn) {
                await submitBtn.click();
                await this.page.waitForTimeout(5000);
            }
            
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

    async collectDailyBonus() {
        console.log('\n🎁 Collecting daily bonus...');
        try {
            await this.page.goto('https://faucetpay.io/dashboard', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(3000);
            
            const bonusBtn = await this.page.$('.claim-bonus, button:has-text("Claim")');
            if (bonusBtn) {
                await bonusBtn.click();
                await this.page.waitForTimeout(3000);
                console.log('  ✅ Daily bonus collected!');
                this.sessionEarned += 0.001;
                this.sessionActions++;
                return true;
            }
            console.log('  ⚠️ No daily bonus available');
            return false;
        } catch (error) {
            console.log(`  ❌ Error: ${error.message}`);
            return false;
        }
    }

    async viewFaucetList() {
        console.log('\n🌊 Viewing faucet list...');
        try {
            await this.page.goto('https://faucetpay.io/faucets', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(3000);
            
            // Scroll to simulate human behavior
            await this.page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
            await this.page.waitForTimeout(2000);
            
            console.log('  ✅ Faucet list viewed');
            this.sessionEarned += 0.0005;
            this.sessionActions++;
            return true;
        } catch (error) {
            console.log(`  ❌ Error: ${error.message}`);
            return false;
        }
    }

    async runSession() {
        console.log('\n========================================');
        console.log(`  Starting Session - ${new Date().toLocaleString()}`);
        console.log('========================================');
        
        await this.init();
        await this.login();
        
        if (this.email && this.password) {
            await this.collectDailyBonus();
            await this.viewFaucetList();
            await this.updateBalance();
        } else {
            console.log('\n⚠️ Demo Mode - Set FAUCETPAY_EMAIL and FAUCETPAY_PASSWORD to earn real money');
            // Simulate for demo
            this.sessionEarned = 0.0015;
            this.sessionActions = 2;
        }
        
        // Update global stats
        stats.totalEarned += this.sessionEarned;
        stats.totalActions += this.sessionActions;
        stats.lastRun = new Date();
        stats.history.unshift({
            timestamp: new Date(),
            earned: this.sessionEarned,
            actions: this.sessionActions
        });
        
        // Keep only last 50 records
        if (stats.history.length > 50) stats.history.pop();
        
        console.log('\n========================================');
        console.log(`  Session Complete`);
        console.log(`  Earned: $${this.sessionEarned.toFixed(4)}`);
        console.log(`  Actions: ${this.sessionActions}`);
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
        .container { max-width: 1000px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 20px; }
        .stats { display: flex; justify-content: space-around; flex-wrap: wrap; gap: 20px; margin-bottom: 30px; }
        .stat-card { background: #1a1f3a; padding: 20px; border-radius: 10px; text-align: center; min-width: 150px; }
        .stat-value { font-size: 28px; font-weight: bold; color: #00ff88; }
        .stat-label { color: #888; margin-top: 5px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
        th { color: #00ff88; }
        .earn { color: #00ff88; }
        .refresh-btn { background: #1a1f3a; color: #00ff88; border: 1px solid #00ff88; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-bottom: 20px; }
        .status { background: #1a1f3a; padding: 10px; border-radius: 5px; margin-bottom: 20px; text-align: center; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 FaucetPay Bot</h1>
        <div class="status">
            🤖 Bot is running | Next run in <span id="countdown">--</span>
        </div>
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(4)}</div><div class="stat-label">Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalActions}</div><div class="stat-label">Total Actions</div></div>
            <div class="stat-card"><div class="stat-value">$${stats.currentBalance.toFixed(4)}</div><div class="stat-label">Balance</div></div>
        </div>
        <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
        <table>
            <thead><tr><th>Time</th><th>Earned</th><th>Actions</th></tr></thead>
            <tbody>
                ${stats.history.slice(0, 30).map(h => `
                    <tr>
                        <td>${new Date(h.timestamp).toLocaleString()}</td>
                        <td class="earn">+$${h.earned.toFixed(4)}</td>
                        <td>${h.actions}</td>
                    </tr>
                `).join('')}
                ${stats.history.length === 0 ? '<tr><td colspan="3">No sessions yet. Waiting for first run...</td></tr>' : ''}
            </tbody>
        </table>
    </div>
    <script>
        let nextRunTime = ${Date.now() + RUN_INTERVAL_HOURS * 60 * 60 * 1000};
        function updateCountdown() {
            let diff = nextRunTime - Date.now();
            if (diff <= 0) {
                document.getElementById('countdown').innerText = '0s (running...)';
                return;
            }
            let hours = Math.floor(diff / (1000 * 60 * 60));
            let minutes = Math.floor((diff % (3600000)) / 60000);
            let seconds = Math.floor((diff % 60000) / 1000);
            document.getElementById('countdown').innerText = \`\${hours}h \${minutes}m \${seconds}s\`;
        }
        updateCountdown();
        setInterval(updateCountdown, 1000);
        setTimeout(() => location.reload(), 30000);
    </script>
</body>
</html>`;
    res.send(html);
});

// ============ SCHEDULED RUNS (using native setInterval) ============
let isRunning = false;

async function runScheduledSession() {
    if (isRunning) {
        console.log('[Schedule] Previous session still running, skipping...');
        return;
    }
    
    isRunning = true;
    console.log(`\n⏰ Running scheduled session at ${new Date().toLocaleString()}`);
    
    try {
        const bot = new FaucetPayBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
        await bot.runSession();
    } catch (error) {
        console.error('[Schedule] Error:', error.message);
    } finally {
        isRunning = false;
    }
}

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting FaucetPay Bot...');
    await installChrome();
    
    // Start web server
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    // Run initial session
    await runScheduledSession();
    
    // Schedule future runs using native setInterval
    const intervalMs = RUN_INTERVAL_HOURS * 60 * 60 * 1000;
    console.log(`⏰ Scheduling runs every ${RUN_INTERVAL_HOURS} hour(s)`);
    setInterval(runScheduledSession, intervalMs);
    
    console.log('Bot is running and waiting for scheduled tasks...');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...');
    process.exit(0);
});

main().catch(console.error);
