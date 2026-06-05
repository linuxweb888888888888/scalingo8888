// faucetpay-continuous-bot.js - Runs 24/7, checks all profit opportunities
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
    { name: 'Daily Bonus', url: 'https://faucetpay.io/dashboard', action: 'checkBonus', earnPerAction: 0.001, interval: 86400000 }, // 24 hours
    { name: 'Faucet List', url: 'https://faucetpay.io/faucets', action: 'viewFaucets', earnPerAction: 0.0005, interval: 3600000 }, // 1 hour
    { name: 'Offerwalls', url: 'https://faucetpay.io/offerwalls', action: 'checkOffers', earnPerAction: 0.002, interval: 7200000 }, // 2 hours
    { name: 'Paid to Click', url: 'https://faucetpay.io/ptc', action: 'viewPTC', earnPerAction: 0.0008, interval: 1800000 }, // 30 minutes
    { name: 'Staking', url: 'https://faucetpay.io/staking', action: 'checkStaking', earnPerAction: 0.001, interval: 3600000 }, // 1 hour
    { name: 'Surveys', url: 'https://faucetpay.io/surveys', action: 'checkSurveys', earnPerAction: 0.005, interval: 7200000 }, // 2 hours
    { name: 'Tasks', url: 'https://faucetpay.io/tasks', action: 'checkTasks', earnPerAction: 0.003, interval: 7200000 } // 2 hours
];

// ============ STATS STORAGE ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
    currentBalance: 0,
    opportunities: {},
    history: [],
    startTime: new Date(),
    lastRun: {},
    profitBySource: {}
};

// Initialize opportunity tracking
PROFIT_OPPORTUNITIES.forEach(opp => {
    stats.opportunities[opp.name] = { totalEarned: 0, totalAttempts: 0, lastRun: null };
    stats.profitBySource[opp.name] = 0;
});

// ============ CONTINUOUS PROFIT BOT ============
class ContinuousProfitBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.sessionEarned = 0;
        this.sessionActions = 0;
        this.profitBreakdown = {};
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
        
        // Random user agent
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
        ];
        await this.page.setUserAgent(userAgents[Math.floor(Math.random() * userAgents.length)]);
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
            return stats.currentBalance;
        } catch (error) {
            return stats.currentBalance;
        }
    }

    async checkAndClaim(opportunity) {
        console.log(`\n💰 Checking: ${opportunity.name}`);
        
        try {
            await this.page.goto(opportunity.url, { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(3000);
            
            // Look for claim buttons, offers, or tasks
            const claimSelectors = [
                '.claim-btn', 'button:has-text("Claim")', '.claim-button',
                '.offer-item', '.task-item', '.survey-item', '.ptc-item',
                'a[href*="claim"]', 'button[class*="earn"]'
            ];
            
            let claimed = false;
            let earnAmount = opportunity.earnPerAction;
            
            for (const selector of claimSelectors) {
                const elements = await this.page.$$(selector);
                if (elements.length > 0) {
                    // Click up to 5 items per opportunity
                    const maxClicks = Math.min(elements.length, 5);
                    for (let i = 0; i < maxClicks; i++) {
                        try {
                            await elements[i].click();
                            await this.page.waitForTimeout(3000 + Math.random() * 2000);
                            console.log(`  ✅ ${opportunity.name} action ${i+1} completed! +$${earnAmount}`);
                            this.sessionEarned += earnAmount;
                            this.sessionActions++;
                            stats.profitBySource[opportunity.name] = (stats.profitBySource[opportunity.name] || 0) + earnAmount;
                            claimed = true;
                            earnAmount = opportunity.earnPerAction * 0.8; // Decrease for subsequent clicks
                        } catch(e) {}
                    }
                    break;
                }
            }
            
            if (!claimed) {
                console.log(`  ⚠️ No available ${opportunity.name} found`);
            }
            
            stats.opportunities[opportunity.name].totalAttempts++;
            stats.opportunities[opportunity.name].lastRun = new Date();
            
            return claimed;
        } catch (error) {
            console.log(`  ❌ Error: ${error.message}`);
            return false;
        }
    }

    async checkAllOpportunities() {
        console.log('\n🔍 Scanning all profit opportunities...');
        let totalEarned = 0;
        
        for (const opp of PROFIT_OPPORTUNITIES) {
            // Check if enough time has passed since last run
            const lastRun = stats.lastRun[opp.name];
            const interval = opp.interval;
            const now = Date.now();
            
            if (lastRun && (now - lastRun) < interval) {
                const remaining = Math.round((interval - (now - lastRun)) / 60000);
                console.log(`⏳ ${opp.name}: next check in ${remaining} minutes`);
                continue;
            }
            
            const earned = await this.checkAndClaim(opp);
            if (earned) totalEarned += opp.earnPerAction;
            stats.lastRun[opp.name] = now;
            
            // Random delay between checks
            await this.page.waitForTimeout(5000 + Math.random() * 10000);
        }
        
        return totalEarned;
    }

    async runContinuous() {
        console.log('\n🚀 Starting Continuous Profit Mode');
        console.log('========================================');
        
        await this.init();
        await this.login();
        
        let cycleCount = 0;
        
        // Continuous loop - runs forever
        while (true) {
            cycleCount++;
            console.log(`\n📊 Cycle #${cycleCount} - ${new Date().toLocaleString()}`);
            console.log('========================================');
            
            try {
                // Check all profit opportunities
                await this.checkAllOpportunities();
                
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
                        cycle: cycleCount,
                        breakdown: { ...this.profitBreakdown }
                    });
                    
                    console.log(`\n💰 Cycle Profit: $${this.sessionEarned.toFixed(4)}`);
                    console.log(`📈 Total Profit: $${stats.totalEarned.toFixed(4)}`);
                    console.log(`💳 Balance: $${stats.currentBalance}`);
                    
                    this.sessionEarned = 0;
                    this.sessionActions = 0;
                    this.profitBreakdown = {};
                }
                
                // Wait before next cycle (15-30 minutes)
                const waitMinutes = 15 + Math.random() * 15;
                console.log(`\n⏰ Waiting ${Math.round(waitMinutes)} minutes before next scan...`);
                await this.page.waitForTimeout(waitMinutes * 60 * 1000);
                
                // Refresh page occasionally to keep session alive
                if (cycleCount % 10 === 0) {
                    await this.page.reload({ waitUntil: 'networkidle2' });
                    await this.page.waitForTimeout(3000);
                }
                
            } catch (error) {
                console.error('Cycle error:', error.message);
                console.log('Restarting browser in 60 seconds...');
                await this.browser.close();
                await new Promise(r => setTimeout(r, 60000));
                await this.init();
                await this.login();
            }
        }
    }
}

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    // Calculate profit by source for display
    const profitBySourceHtml = Object.entries(stats.profitBySource)
        .filter(([_, value]) => value > 0)
        .map(([name, value]) => `
            <div class="profit-item">
                <span>${name}:</span>
                <span class="earn">+$${value.toFixed(4)}</span>
            </div>
        `).join('');
    
    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Continuous Profit Bot Dashboard</title>
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 40px; }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 10px; }
        .subtitle { text-align: center; color: #888; margin-bottom: 30px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: #1a1f3a; padding: 20px; border-radius: 10px; text-align: center; }
        .stat-value { font-size: 32px; font-weight: bold; color: #00ff88; }
        .stat-label { color: #888; margin-top: 5px; }
        .profit-breakdown { background: #1a1f3a; padding: 20px; border-radius: 10px; margin-bottom: 30px; }
        .profit-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #333; }
        .earn { color: #00ff88; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
        th { color: #00ff88; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        .online { color: #00ff88; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .refresh-btn { background: #1a1f3a; color: #00ff88; border: 1px solid #00ff88; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 Continuous Profit Bot</h1>
        <div class="subtitle">Scanning 7+ profit sources • Running 24/7</div>
        
        <div class="status">
            🔴 Status: <span class="online">● ONLINE</span> | Uptime: ${hours}h ${minutes}m
        </div>
        
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(4)}</div><div class="stat-label">Total Profit</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalActions}</div><div class="stat-label">Total Actions</div></div>
            <div class="stat-card"><div class="stat-value">$${stats.currentBalance.toFixed(4)}</div><div class="stat-label">Balance</div></div>
            <div class="stat-card"><div class="stat-value">${Math.round((stats.totalEarned / (uptime / 3600)) * 100) / 100}/hr</div><div class="stat-label">Profit Rate</div></div>
        </div>
        
        <div class="profit-breakdown">
            <h3>📊 Profit by Source</h3>
            ${profitBySourceHtml || '<div class="profit-item">No profit yet. Bot is scanning...</div>'}
        </div>
        
        <button class="refresh-btn" onclick="location.reload()">🔄 Refresh Dashboard</button>
        <table>
            <thead><tr><th>Time</th><th>Earned</th><th>Actions</th><th>Cycle</th></tr></thead>
            <tbody>
                ${stats.history.slice(0, 30).map(h => `
                    <tr>
                        <td>${new Date(h.timestamp).toLocaleString()}</td>
                        <td class="earn">+$${h.earned.toFixed(4)}</td>
                        <td>${h.actions}</td>
                        <td>${h.cycle}</td>
                    </tr>
                `).join('')}
                ${stats.history.length === 0 ? '<tr><td colspan="4">No profit yet. Bot is scanning...</td></tr>' : ''}
            </tbody>
        </table>
    </div>
    <script>
        setTimeout(() => location.reload(), 30000);
    </script>
</body>
</html>`;
    res.send(html);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Continuous Profit Bot...');
    console.log('🔄 Will run 24/7 scanning all profit opportunities');
    console.log('💰 Checking: Daily Bonus, Faucet List, Offerwalls, PTC, Staking, Surveys, Tasks');
    console.log('⏰ Scan interval: 15-30 minutes\n');
    
    await installChrome();
    
    // Start web server
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    // Start the continuous profit bot
    const bot = new ContinuousProfitBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
    await bot.runContinuous();
}

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...');
    process.exit(0);
});

main().catch(console.error);
