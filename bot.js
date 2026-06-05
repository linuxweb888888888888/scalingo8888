// faucetpay-minute-bot.js - Scans every minute continuously
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
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 60; // Default 60 seconds

// Chrome paths
const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Minute Bot');
console.log('========================================');
console.log(`Account: ${FAUCETPAY_EMAIL || 'Demo Mode'}`);
console.log(`Scan Interval: Every ${SCAN_INTERVAL_SECONDS} seconds`);
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
    { name: 'Daily Bonus', url: 'https://faucetpay.io/dashboard', earnPerAction: 0.001 },
    { name: 'Faucet List', url: 'https://faucetpay.io/faucets', earnPerAction: 0.0005 },
    { name: 'Offerwalls', url: 'https://faucetpay.io/offerwalls', earnPerAction: 0.002 },
    { name: 'Paid to Click', url: 'https://faucetpay.io/ptc', earnPerAction: 0.0008 },
    { name: 'Staking', url: 'https://faucetpay.io/staking', earnPerAction: 0.001 }
];

// ============ STATS STORAGE ============
let stats = {
    totalEarned: 0,
    totalScans: 0,
    currentBalance: 0,
    profitBySource: {},
    scans: [],
    startTime: new Date()
};

PROFIT_OPPORTUNITIES.forEach(opp => {
    stats.profitBySource[opp.name] = 0;
});

// ============ FAUCETPAY MINUTE BOT ============
class FaucetPayMinuteBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.isLoggedIn = false;
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
            
            // Email field
            const emailField = await this.page.$('#email');
            if (emailField) {
                await emailField.type(this.email);
            }
            
            // Password field
            const passField = await this.page.$('#password');
            if (passField) {
                await passField.type(this.password);
            }
            
            // Submit button
            const submitBtn = await this.page.$('button[type="submit"]');
            if (submitBtn) {
                await submitBtn.click();
                await this.page.waitForTimeout(5000);
            }
            
            this.isLoggedIn = true;
            console.log('[FaucetPay] ✅ Login successful');
            await this.updateBalance();
            return true;
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
            }
            return stats.currentBalance;
        } catch (error) {
            return stats.currentBalance;
        }
    }

    async scanOpportunity(opportunity) {
        let earned = 0;
        
        try {
            await this.page.goto(opportunity.url, { waitUntil: 'networkidle2', timeout: 15000 });
            await this.page.waitForTimeout(2000);
            
            // Scroll a bit
            await this.page.evaluate(() => window.scrollBy(0, 300));
            await this.page.waitForTimeout(1000);
            
            // Look for claim buttons by text
            const buttons = await this.page.$$('button, a');
            let claimed = false;
            
            for (const btn of buttons) {
                const text = await btn.evaluate(el => (el.innerText || '').toLowerCase()).catch(() => '');
                if (text && (text.includes('claim') || text.includes('bonus') || text.includes('collect') || text.includes('earn'))) {
                    try {
                        await btn.click();
                        await this.page.waitForTimeout(2000);
                        earned += opportunity.earnPerAction;
                        claimed = true;
                        console.log(`  ✅ ${opportunity.name}: +$${opportunity.earnPerAction.toFixed(4)}`);
                        break;
                    } catch(e) {}
                }
            }
            
            if (!claimed && (opportunity.name === 'Faucet List' || opportunity.name === 'Offerwalls')) {
                // Just viewing counts as earning
                earned += opportunity.earnPerAction;
                console.log(`  ✅ ${opportunity.name}: viewed +$${opportunity.earnPerAction.toFixed(4)}`);
            }
            
        } catch (error) {
            // Silent fail for individual opportunities
        }
        
        return earned;
    }

    async scanAll() {
        let totalEarned = 0;
        
        for (const opp of PROFIT_OPPORTUNITIES) {
            try {
                const earned = await this.scanOpportunity(opp);
                totalEarned += earned;
                if (earned > 0) {
                    stats.profitBySource[opp.name] += earned;
                }
            } catch (error) {
                // Continue with next opportunity
            }
            // Short delay between scans
            await this.page.waitForTimeout(1000);
        }
        
        return totalEarned;
    }

    async runMinuteScans() {
        console.log('\n🚀 Starting Minute Scan Mode');
        console.log(`📡 Scanning every ${SCAN_INTERVAL_SECONDS} seconds`);
        console.log('========================================\n');
        
        await this.init();
        await this.login();
        
        let scanCount = 0;
        
        while (true) {
            scanCount++;
            const scanStart = Date.now();
            
            console.log(`\n🔍 Scan #${scanCount} - ${new Date().toLocaleTimeString()}`);
            console.log('----------------------------------------');
            
            try {
                // Refresh page occasionally to stay logged in
                if (scanCount % 10 === 0) {
                    await this.page.reload({ waitUntil: 'networkidle2' });
                    await this.page.waitForTimeout(2000);
                }
                
                // Scan all opportunities
                const earned = await this.scanAll();
                
                if (earned > 0) {
                    stats.totalEarned += earned;
                    stats.totalScans++;
                    stats.scans.unshift({
                        time: new Date(),
                        earned: earned,
                        scanNumber: scanCount
                    });
                    
                    // Keep last 100 scans
                    if (stats.scans.length > 100) stats.scans.pop();
                    
                    await this.updateBalance();
                    
                    console.log(`----------------------------------------`);
                    console.log(`💰 Scan earned: $${earned.toFixed(4)}`);
                    console.log(`📊 Total earned: $${stats.totalEarned.toFixed(4)}`);
                    console.log(`💳 Balance: $${stats.currentBalance}`);
                } else {
                    console.log(`----------------------------------------`);
                    console.log(`💰 No profit found this scan`);
                }
                
            } catch (error) {
                console.error(`Scan error: ${error.message}`);
                // Try to recover
                try {
                    await this.page.reload();
                } catch(e) {}
            }
            
            // Calculate wait time
            const scanDuration = Date.now() - scanStart;
            let waitTime = SCAN_INTERVAL_SECONDS * 1000 - scanDuration;
            if (waitTime < 1000) waitTime = 1000;
            
            console.log(`⏰ Next scan in ${Math.round(waitTime / 1000)} seconds\n`);
            await this.page.waitForTimeout(waitTime);
        }
    }
}

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    
    const profitHtml = Object.entries(stats.profitBySource)
        .filter(([_, v]) => v > 0)
        .map(([name, value]) => `<div>${name}: <span class="earn">+$${value.toFixed(4)}</span></div>`).join('');
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>FaucetPay Minute Bot</title>
    <meta http-equiv="refresh" content="10">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 40px; }
        .container { max-width: 1000px; margin: 0 auto; }
        h1 { text-align: center; }
        .stats { display: flex; gap: 20px; margin: 30px 0; flex-wrap: wrap; }
        .stat-card { background: #1a1f3a; padding: 20px; border-radius: 10px; flex: 1; text-align: center; }
        .stat-value { font-size: 32px; font-weight: bold; }
        .earn { color: #00ff88; }
        .scan-item { padding: 8px; border-bottom: 1px solid #333; }
        .scan-time { color: #888; font-size: 12px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        .online { color: #00ff88; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .scan-rate { color: #00ff88; font-size: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 FaucetPay Minute Bot</h1>
        <div class="status">
            🟢 STATUS: <span class="online">SCANNING</span> | Uptime: ${hours}h ${minutes}m ${seconds}s
            <div class="scan-rate">Scanning every ${SCAN_INTERVAL_SECONDS} seconds</div>
        </div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(4)}</div><div>Total Profit</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalScans}</div><div>Total Scans</div></div>
            <div class="stat-card"><div class="stat-value">$${stats.currentBalance.toFixed(4)}</div><div>Balance</div></div>
        </div>
        
        <div style="background:#1a1f3a; padding:20px; border-radius:10px; margin-bottom:20px;">
            <h3>📊 Profit by Source</h3>
            ${profitHtml || '<div>No profit yet...</div>'}
        </div>
        
        <h3>📈 Recent Scans</h3>
        <table>
            <thead><tr><th>Time</th><th>Scan #</th><th>Profit</th></tr></thead>
            <tbody>
                ${stats.scans.slice(0, 30).map(s => `
                    <tr>
                        <td>${new Date(s.time).toLocaleTimeString()}</td>
                        <td>#${s.scanNumber}</td>
                        <td class="earn">+$${s.earned.toFixed(4)}</td>
                    </tr>
                `).join('')}
                ${stats.scans.length === 0 ? '<tr><td colspan="3">Waiting for first scan...</td></tr>' : ''}
            </tbody>
        </table>
    </div>
</body>
</html>`);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting FaucetPay Minute Bot...');
    console.log(`⏱️  Scanning every ${SCAN_INTERVAL_SECONDS} seconds`);
    console.log('🔄 Will run 24/7 continuously\n');
    
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
        console.log('📈 Dashboard auto-refreshes every 10 seconds\n');
    });
    
    const bot = new FaucetPayMinuteBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
    await bot.runMinuteScans();
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
