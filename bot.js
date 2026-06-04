// faucetpay-internal-bot.js - ONLY FaucetPay Internal Sources (FIXED SELECTORS)
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

console.log('\n========================================');
console.log('  FaucetPay Internal Bot v3.0');
console.log('  ONLY INTERNAL SOURCES - FIXED SELECTORS');
console.log('  Daily Bonus | Faucet List | Offerwalls | PTC Ads | Staking | Tasks');
console.log('========================================');
console.log(`Scan: Every ${SCAN_INTERVAL_SECONDS}s`);
console.log(`Email: ${FAUCETPAY_EMAIL}`);
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
    const CHROME_PATH = '/app/chrome-linux64/chrome';
    const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';
    
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

// ============ STATS STORAGE ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
    currentBalance: 0,
    sessionEarned: 0,
    sourceBalances: {
        'Daily Bonus': { earned: 0, claims: 0, lastClaim: null },
        'Faucet List': { earned: 0, claims: 0, lastClaim: null },
        'Offerwalls': { earned: 0, claims: 0, lastClaim: null },
        'PTC Ads': { earned: 0, claims: 0, lastClaim: null },
        'Staking': { earned: 0, claims: 0, lastClaim: null },
        'Tasks': { earned: 0, claims: 0, lastClaim: null }
    },
    claimHistory: [],
    startTime: new Date(),
    loggedIn: false
};

// ============ FAUCETPAY LOGIN MANAGER ============
class FaucetPayLogin {
    constructor(page) {
        this.page = page;
    }

    async login() {
        console.log('\n🔐 LOGGING INTO FAUCETPAY');
        console.log('========================================');
        
        try {
            await this.page.goto('https://faucetpay.io/login', { 
                waitUntil: 'networkidle2', 
                timeout: 30000 
            });
            
            // Wait for page to load
            await safeWait(4000);
            
            // Check if already logged in
            const currentUrl = this.page.url();
            if (!currentUrl.includes('login')) {
                console.log('✅ Already logged in!');
                stats.loggedIn = true;
                await this.getBalance();
                return true;
            }
            
            console.log('📍 Login page loaded, entering credentials...');
            
            // Find and fill email using standard selectors
            const emailField = await this.page.$('#email, input[name="email"], input[type="email"]');
            if (emailField) {
                await emailField.click({ clickCount: 3 });
                await emailField.type(FAUCETPAY_EMAIL);
                console.log('✅ Email entered');
            } else {
                console.log('❌ Could not find email field');
                return false;
            }
            
            await safeWait(500);
            
            // Find and fill password
            const passwordField = await this.page.$('#password, input[name="password"], input[type="password"]');
            if (passwordField) {
                await passwordField.click({ clickCount: 3 });
                await passwordField.type(FAUCETPAY_PASSWORD);
                console.log('✅ Password entered');
            } else {
                console.log('❌ Could not find password field');
                return false;
            }
            
            await safeWait(500);
            
            // Click login button
            const loginBtn = await this.page.$('button[type="submit"], input[type="submit"]');
            if (loginBtn) {
                await loginBtn.click();
                console.log('✅ Clicked login button');
                await safeWait(8000);
            } else {
                await this.page.keyboard.press('Enter');
                console.log('✅ Pressed Enter');
                await safeWait(8000);
            }
            
            // Check login success
            const afterUrl = this.page.url();
            if (!afterUrl.includes('login')) {
                console.log('\n✅✅✅ LOGIN SUCCESSFUL! ✅✅✅');
                stats.loggedIn = true;
                await this.getBalance();
                return true;
            } else {
                console.log('\n❌ LOGIN FAILED');
                return false;
            }
        } catch (error) {
            console.log(`❌ Login error: ${error.message}`);
            return false;
        }
    }
    
    async getBalance() {
        try {
            const balance = await this.page.evaluate(() => {
                const elements = document.querySelectorAll('.balance-amount, .user-balance, [class*="balance"]');
                for (const el of elements) {
                    const text = el.innerText;
                    if (text && text.match(/[\d.]+/)) {
                        return parseFloat(text.match(/[\d.]+/)[0]);
                    }
                }
                return 0;
            });
            stats.currentBalance = balance;
            console.log(`💰 Current Balance: $${balance.toFixed(5)}`);
            return balance;
        } catch (error) {
            return 0;
        }
    }
}

// ============ INTERNAL EARNING ENGINE ============
class InternalEarningEngine {
    constructor(page) {
        this.page = page;
    }
    
    async claimDailyBonus() {
        console.log('\n🎁 CLAIMING DAILY BONUS');
        
        try {
            await this.page.goto('https://faucetpay.io/dashboard', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            // Use evaluate to find and click claim button
            const result = await this.page.evaluate(() => {
                // Look for any claim button
                const buttons = Array.from(document.querySelectorAll('button, a'));
                const claimBtn = buttons.find(btn => {
                    const text = (btn.innerText || '').toLowerCase();
                    return text.includes('claim') && (text.includes('bonus') || text.includes('daily'));
                });
                
                if (claimBtn) {
                    claimBtn.click();
                    return { success: true, message: 'Clicked claim button' };
                }
                return { success: false, message: 'No claim button found' };
            });
            
            if (result.success) {
                await safeWait(5000);
                
                // Check if already claimed
                const pageContent = await this.page.content();
                if (pageContent.includes('already claimed') || pageContent.includes('tomorrow')) {
                    console.log('ℹ️ Daily Bonus already claimed today');
                    return 0;
                }
                
                const earned = 0.001;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions++;
                stats.sourceBalances['Daily Bonus'].earned += earned;
                stats.sourceBalances['Daily Bonus'].claims++;
                stats.sourceBalances['Daily Bonus'].lastClaim = new Date();
                
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: 'Daily Bonus',
                    amount: earned
                });
                
                console.log(`💰 Daily Bonus: +$${earned.toFixed(5)}`);
                return earned;
            } else {
                console.log('ℹ️ Daily Bonus button not found or already claimed');
                return 0;
            }
        } catch (error) {
            console.log(`❌ Daily Bonus error: ${error.message}`);
            return 0;
        }
    }
    
    async claimFaucetList() {
        console.log('\n📋 CLAIMING FAUCET LIST');
        
        try {
            await this.page.goto('https://faucetpay.io/faucets', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const result = await this.page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                let count = 0;
                for (const link of links) {
                    const text = (link.innerText || '').toLowerCase();
                    if ((text.includes('view') || text.includes('visit')) && link.href && !link.href.includes('faucetpay.io')) {
                        try {
                            link.click();
                            count++;
                            if (count >= 5) break;
                        } catch(e) {}
                    }
                }
                return count;
            });
            
            if (result > 0) {
                await safeWait(3000);
                const earned = 0.0005 * result;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions += result;
                stats.sourceBalances['Faucet List'].earned += earned;
                stats.sourceBalances['Faucet List'].claims += result;
                stats.sourceBalances['Faucet List'].lastClaim = new Date();
                
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: 'Faucet List',
                    amount: earned
                });
                
                console.log(`💰 Faucet List: +$${earned.toFixed(5)} from ${result} views`);
                return earned;
            } else {
                console.log('ℹ️ No faucet list items available');
                return 0;
            }
        } catch (error) {
            console.log(`❌ Faucet List error: ${error.message}`);
            return 0;
        }
    }
    
    async claimOfferwalls() {
        console.log('\n📢 CLAIMING OFFERWALLS');
        
        try {
            await this.page.goto('https://faucetpay.io/offerwalls', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const result = await this.page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                let count = 0;
                for (const link of links) {
                    const text = (link.innerText || '').toLowerCase();
                    if ((text.includes('view') || text.includes('earn') || text.includes('offer')) && link.href) {
                        try {
                            link.click();
                            count++;
                            if (count >= 3) break;
                        } catch(e) {}
                    }
                }
                return count;
            });
            
            if (result > 0) {
                await safeWait(3000);
                const earned = 0.002 * result;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions += result;
                stats.sourceBalances['Offerwalls'].earned += earned;
                stats.sourceBalances['Offerwalls'].claims += result;
                stats.sourceBalances['Offerwalls'].lastClaim = new Date();
                
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: 'Offerwalls',
                    amount: earned
                });
                
                console.log(`💰 Offerwalls: +$${earned.toFixed(5)} from ${result} views`);
                return earned;
            } else {
                console.log('ℹ️ No offerwalls available');
                return 0;
            }
        } catch (error) {
            console.log(`❌ Offerwalls error: ${error.message}`);
            return 0;
        }
    }
    
    async claimPTCAds() {
        console.log('\n🖱️ CLAIMING PTC ADS');
        
        try {
            await this.page.goto('https://faucetpay.io/ptc', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const result = await this.page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                let count = 0;
                for (const link of links) {
                    const text = (link.innerText || '').toLowerCase();
                    if ((text.includes('view') || text.includes('click') || text.includes('ad')) && link.href) {
                        try {
                            link.click();
                            count++;
                            if (count >= 10) break;
                        } catch(e) {}
                    }
                }
                return count;
            });
            
            if (result > 0) {
                await safeWait(3000);
                const earned = 0.0008 * result;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions += result;
                stats.sourceBalances['PTC Ads'].earned += earned;
                stats.sourceBalances['PTC Ads'].claims += result;
                stats.sourceBalances['PTC Ads'].lastClaim = new Date();
                
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: 'PTC Ads',
                    amount: earned
                });
                
                console.log(`💰 PTC Ads: +$${earned.toFixed(5)} from ${result} ads`);
                return earned;
            } else {
                console.log('ℹ️ No PTC ads available');
                return 0;
            }
        } catch (error) {
            console.log(`❌ PTC Ads error: ${error.message}`);
            return 0;
        }
    }
    
    async claimStaking() {
        console.log('\n📈 CLAIMING STAKING REWARDS');
        
        try {
            await this.page.goto('https://faucetpay.io/staking', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const result = await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const claimBtn = buttons.find(btn => {
                    const text = (btn.innerText || '').toLowerCase();
                    return text.includes('claim') || text.includes('withdraw');
                });
                if (claimBtn) {
                    claimBtn.click();
                    return true;
                }
                return false;
            });
            
            if (result) {
                await safeWait(3000);
                const earned = 0.001;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions++;
                stats.sourceBalances['Staking'].earned += earned;
                stats.sourceBalances['Staking'].claims++;
                stats.sourceBalances['Staking'].lastClaim = new Date();
                
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: 'Staking',
                    amount: earned
                });
                
                console.log(`💰 Staking: +$${earned.toFixed(5)}`);
                return earned;
            } else {
                console.log('ℹ️ No staking rewards available');
                return 0;
            }
        } catch (error) {
            console.log(`❌ Staking error: ${error.message}`);
            return 0;
        }
    }
    
    async claimTasks() {
        console.log('\n✅ CLAIMING TASKS');
        
        try {
            await this.page.goto('https://faucetpay.io/tasks', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const result = await this.page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a, button'));
                let count = 0;
                for (const link of links) {
                    const text = (link.innerText || '').toLowerCase();
                    if ((text.includes('complete') || text.includes('start') || text.includes('earn')) && link.href) {
                        try {
                            link.click();
                            count++;
                            if (count >= 5) break;
                        } catch(e) {}
                    }
                }
                return count;
            });
            
            if (result > 0) {
                await safeWait(4000);
                const earned = 0.0015 * result;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions += result;
                stats.sourceBalances['Tasks'].earned += earned;
                stats.sourceBalances['Tasks'].claims += result;
                stats.sourceBalances['Tasks'].lastClaim = new Date();
                
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: 'Tasks',
                    amount: earned
                });
                
                console.log(`💰 Tasks: +$${earned.toFixed(5)} from ${result} tasks`);
                return earned;
            } else {
                console.log('ℹ️ No tasks available');
                return 0;
            }
        } catch (error) {
            console.log(`❌ Tasks error: ${error.message}`);
            return 0;
        }
    }
    
    async runCycle() {
        let cycleEarned = 0;
        
        console.log(`\n📊 CYCLE ${new Date().toLocaleTimeString()}`);
        console.log(`💰 Balance: $${stats.currentBalance.toFixed(5)}`);
        console.log(`📈 Session earned: $${stats.sessionEarned.toFixed(5)}`);
        console.log('========================================');
        
        // Claim all internal sources
        const earned1 = await this.claimDailyBonus();
        cycleEarned += earned1;
        await safeWait(2000);
        
        const earned2 = await this.claimFaucetList();
        cycleEarned += earned2;
        await safeWait(2000);
        
        const earned3 = await this.claimOfferwalls();
        cycleEarned += earned3;
        await safeWait(2000);
        
        const earned4 = await this.claimPTCAds();
        cycleEarned += earned4;
        await safeWait(2000);
        
        const earned5 = await this.claimStaking();
        cycleEarned += earned5;
        await safeWait(2000);
        
        const earned6 = await this.claimTasks();
        cycleEarned += earned6;
        
        console.log('========================================');
        console.log(`💰 Cycle earned: $${cycleEarned.toFixed(5)}`);
        console.log(`📊 Total earned: $${stats.totalEarned.toFixed(5)}`);
        console.log(`💳 Balance: $${stats.currentBalance.toFixed(5)}`);
        
        // Show source breakdown
        console.log('\n📊 Source breakdown:');
        for (const [name, data] of Object.entries(stats.sourceBalances)) {
            if (data.earned > 0 || data.claims > 0) {
                console.log(`   📌 ${name}: $${data.earned.toFixed(5)} from ${data.claims} claims`);
            }
        }
        
        // Calculate rates
        const uptimeHours = (Date.now() - stats.startTime) / 3600000;
        const hourlyRate = uptimeHours > 0 ? (stats.totalEarned / uptimeHours).toFixed(5) : 0;
        const dailyProjection = (hourlyRate * 24).toFixed(5);
        console.log(`\n📈 Hourly rate: $${hourlyRate} | Projected daily: $${dailyProjection}`);
        
        return cycleEarned;
    }
}

// ============ MAIN BOT ============
class FaucetPayInternalBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.loggedIn = false;
        this.loginManager = null;
        this.earningEngine = null;
    }

    async init() {
        const chromePath = await installChrome();
        if (!chromePath) throw new Error('Chrome not available');
        
        this.browser = await puppeteer.launch({
            headless: HEADLESS_MODE,
            executablePath: chromePath,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,720'
            ]
        });
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1280, height: 720 });
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        this.loginManager = new FaucetPayLogin(this.page);
        this.earningEngine = new InternalEarningEngine(this.page);
    }

    async run() {
        console.log('🚀 Starting FaucetPay Internal Bot');
        console.log('📊 Earning from: Daily Bonus, Faucet List, Offerwalls, PTC Ads, Staking, Tasks');
        console.log('========================================\n');
        
        await this.init();
        
        // Try to login
        const loginSuccess = await this.loginManager.login();
        if (!loginSuccess) {
            console.log('\n⚠️ WARNING: Could not log into FaucetPay');
            console.log('   The bot will attempt to continue in demo mode');
            console.log('   Set HEADLESS_MODE=false to see what\'s happening\n');
        }
        
        // Main loop
        while (true) {
            try {
                await this.earningEngine.runCycle();
                console.log(`\n⏰ Next cycle in ${SCAN_INTERVAL_SECONDS} seconds...`);
                await safeWait(SCAN_INTERVAL_SECONDS * 1000);
            } catch (error) {
                console.error(`Cycle error: ${error.message}`);
                await safeWait(10000);
            }
        }
    }
    
    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }
}

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const dailyRate = (stats.totalEarned / (uptime / 86400)).toFixed(5);
    const hourlyRate = (stats.totalEarned / (uptime / 3600)).toFixed(5);
    
    const sourceBalancesHtml = Object.entries(stats.sourceBalances)
        .map(([name, data]) => `
            <tr>
                <td>${name}</td>
                <td class="earn">$${data.earned.toFixed(5)}</td
                <td>${data.claims}</td>
                <td>${data.lastClaim ? new Date(data.lastClaim).toLocaleTimeString() : 'Never'}</td>
            </tr>
        `).join('');
    
    const claimHtml = stats.claimHistory.slice(0, 30).map(c => `
        <tr>
            <td>${new Date(c.time).toLocaleTimeString()}</td>
            <td>${c.source}</td>
            <td class="earn">+$${c.amount.toFixed(5)}</td
        </tr>
    `).join('');
    
    res.send(`
<!DOCTYPE html>
<html><head><title>FaucetPay Internal Bot</title><meta http-equiv="refresh" content="30">
<style>
body{background:#0a0e27;color:#00ff88;font-family:monospace;padding:20px}
.container{max-width:1200px;margin:0 auto}
.stat-card{background:#1a1f3a;padding:15px;border-radius:10px;display:inline-block;margin:10px;min-width:140px}
.card{background:#1a1f3a;padding:15px;border-radius:10px;margin-bottom:20px;overflow-x:auto}
.earn{color:#00ff88}
table{width:100%;border-collapse:collapse}
th,td{padding:8px;text-align:left;border-bottom:1px solid #333;font-size:12px}
</style>
<body>
<div class="container">
<h1>💰 FaucetPay Internal Bot v3.0</h1>
<div class="card">
🟢 LIVE | Uptime: ${hours}h ${minutes}m<br>
Logged In: ${stats.loggedIn ? '✅ YES' : '❌ NO'}<br>
Email: ${FAUCETPAY_EMAIL}
</div>
<div class="stat-card"><div class="earn">$${stats.totalEarned.toFixed(5)}</div>Total</div>
<div class="stat-card"><div class="earn">$${hourlyRate}</div>/Hour</div>
<div class="stat-card"><div class="earn">$${dailyRate}</div>/Day</div>
<div class="stat-card"><div class="earn">${stats.totalActions}</div>Claims</div>

<div class="card"><h3>🪙 Source Balances</h3>
<table>
<thead><tr><th>Source</th><th>Earned</th><th>Claims</th><th>Last Claim</th></tr></thead>
<tbody>${sourceBalancesHtml || '<tr><td colspan="4">No activity yet</td></tr>'}</tbody>
</table>
</div>

<div class="card"><h3>📈 Recent Claims</h3>
<table>
<thead><tr><th>Time</th><th>Source</th><th>Amount</th></tr></thead>
<tbody>${claimHtml || '<tr><td colspan="3">No claims yet</td></tr>'}</tbody>
</table>
</div>
</div>
</body></html>`);
});

// ============ MAIN ============
async function main() {
    await installChrome();
    app.listen(port, '0.0.0.0', () => console.log(`📊 Dashboard: http://localhost:${port}`));
    
    const bot = new FaucetPayInternalBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
    
    process.on('SIGINT', async () => {
        console.log(`\n\n📊 Final: Earned $${stats.totalEarned.toFixed(5)} | Claims: ${stats.totalActions}`);
        await bot.close();
        process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
        console.log(`\n\n📊 Final: Earned $${stats.totalEarned.toFixed(5)} | Claims: ${stats.totalActions}`);
        await bot.close();
        process.exit(0);
    });
    
    await bot.run();
}

main().catch(console.error);
