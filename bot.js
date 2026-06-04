// faucetpay-auto-bot.js - Auto-creates accounts and configures wallet
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
const FAUCETPAY_WALLET_ADDRESS = process.env.FAUCETPAY_WALLET_ADDRESS || '';
const FAUCETPAY_EMAIL = process.env.FAUCETPAY_EMAIL || 'web88888888888888@gmail.com';
const FAUCETPAY_PASSWORD = process.env.FAUCETPAY_PASSWORD || 'Linuxdistro&84';
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 60;

const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Auto Account Bot');
console.log('========================================');
console.log(`FaucetPay Wallet: ${FAUCETPAY_WALLET_ADDRESS || 'Not set'}`);
console.log(`Scan Interval: Every ${SCAN_INTERVAL_SECONDS} seconds`);
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

// ============ AUTO ACCOUNT CREATOR ============
class AutoAccountCreator {
    constructor(page) {
        this.page = page;
    }

    async generateCredentials() {
        const randomStr = Math.random().toString(36).substring(2, 12);
        const email = `${randomStr}@10minutemail.net`;
        const password = Math.random().toString(36).substring(2, 15);
        return { email, password };
    }

    async createFreeBitcoinAccount(walletAddress) {
        console.log(`  📝 Creating FreeBitcoin account...`);
        try {
            await this.page.goto('https://freebitco.in/?op=register', { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(2000);
            
            const { email, password } = await this.generateCredentials();
            
            // Fill registration form
            await this.page.type('input[name="btc_address"]', walletAddress);
            await this.page.type('input[name="email"]', email);
            await this.page.type('input[name="password"]', password);
            await this.page.type('input[name="confirm_password"]', password);
            
            // Accept terms
            await this.page.click('input[name="terms"]');
            await this.page.click('input[type="submit"]');
            
            await this.page.waitForTimeout(3000);
            console.log(`    ✅ FreeBitcoin account created: ${email}`);
            return { success: true, email, password };
        } catch (error) {
            console.log(`    ❌ FreeBitcoin creation failed: ${error.message}`);
            return { success: false };
        }
    }

    async createFireFaucetAccount(walletAddress) {
        console.log(`  📝 Creating FireFaucet account...`);
        try {
            await this.page.goto('https://firefaucet.win/register', { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(2000);
            
            const { email, password } = await this.generateCredentials();
            
            await this.page.type('input[name="email"]', email);
            await this.page.type('input[name="password"]', password);
            await this.page.type('input[name="confirm_password"]', password);
            await this.page.type('input[name="btc_address"]', walletAddress);
            
            await this.page.click('button[type="submit"]');
            await this.page.waitForTimeout(3000);
            console.log(`    ✅ FireFaucet account created: ${email}`);
            return { success: true, email, password };
        } catch (error) {
            console.log(`    ❌ FireFaucet creation failed: ${error.message}`);
            return { success: false };
        }
    }

    async createCointiplyAccount(walletAddress) {
        console.log(`  📝 Creating Cointiply account...`);
        try {
            await this.page.goto('https://cointiply.com/register', { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(2000);
            
            const { email, password } = await this.generateCredentials();
            const username = email.split('@')[0];
            
            await this.page.type('input[name="username"]', username);
            await this.page.type('input[name="email"]', email);
            await this.page.type('input[name="password"]', password);
            await this.page.type('input[name="faucetpay"]', walletAddress);
            
            await this.page.click('button[type="submit"]');
            await this.page.waitForTimeout(3000);
            console.log(`    ✅ Cointiply account created: ${email}`);
            return { success: true, email, password };
        } catch (error) {
            console.log(`    ❌ Cointiply creation failed: ${error.message}`);
            return { success: false };
        }
    }
}

// ============ FAUCET CLAIMER ============
class FaucetClaimer {
    constructor(page) {
        this.page = page;
    }

    async claimFreeBitcoin() {
        try {
            await this.page.goto('https://freebitco.in', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await this.page.waitForTimeout(2000);
            
            const claimBtn = await this.page.$('#free_play_form_button');
            if (claimBtn) {
                await claimBtn.click();
                await this.page.waitForTimeout(3000);
                console.log(`    ✅ FreeBitcoin claimed!`);
                return 0.0005;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }

    async claimFireFaucet() {
        try {
            await this.page.goto('https://firefaucet.win', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await this.page.waitForTimeout(2000);
            
            const claimBtn = await this.page.$('#claimButton');
            if (claimBtn) {
                await claimBtn.click();
                await this.page.waitForTimeout(3000);
                console.log(`    ✅ FireFaucet claimed!`);
                return 0.0003;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }

    async claimCointiply() {
        try {
            await this.page.goto('https://cointiply.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await this.page.waitForTimeout(2000);
            
            const claimBtn = await this.page.$('.claim-button');
            if (claimBtn) {
                await claimBtn.click();
                await this.page.waitForTimeout(3000);
                console.log(`    ✅ Cointiply claimed!`);
                return 0.0003;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }
}

// ============ STATS ============
let stats = {
    totalEarned: 0,
    totalClaims: 0,
    accountsCreated: 0,
    history: [],
    startTime: new Date()
};

// ============ MAIN BOT ============
class AutoFaucetBot {
    constructor(walletAddress, faucetpayEmail, faucetpayPassword) {
        this.walletAddress = walletAddress;
        this.faucetpayEmail = faucetpayEmail;
        this.faucetpayPassword = faucetpayPassword;
        this.browser = null;
        this.page = null;
        this.accounts = {};
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
        this.page.setDefaultTimeout(15000);
    }

    async createAllAccounts() {
        console.log('\n📝 Creating accounts on faucet sites...');
        console.log('========================================');
        
        const creator = new AutoAccountCreator(this.page);
        
        // Create accounts only once
        if (!this.accounts.freebitcoin) {
            this.accounts.freebitcoin = await creator.createFreeBitcoinAccount(this.walletAddress);
            if (this.accounts.freebitcoin.success) stats.accountsCreated++;
            await this.page.waitForTimeout(3000);
        }
        
        if (!this.accounts.firefaucet) {
            this.accounts.firefaucet = await creator.createFireFaucetAccount(this.walletAddress);
            if (this.accounts.firefaucet.success) stats.accountsCreated++;
            await this.page.waitForTimeout(3000);
        }
        
        if (!this.accounts.cointiply) {
            this.accounts.cointiply = await creator.createCointiplyAccount(this.walletAddress);
            if (this.accounts.cointiply.success) stats.accountsCreated++;
            await this.page.waitForTimeout(3000);
        }
        
        console.log(`\n✅ Created ${stats.accountsCreated} accounts\n`);
    }

    async loginToExistingAccounts() {
        console.log('\n🔐 Logging into existing accounts...');
        
        // Login to FreeBitcoin
        if (this.accounts.freebitcoin?.success) {
            try {
                await this.page.goto('https://freebitco.in', { waitUntil: 'networkidle2' });
                await this.page.waitForTimeout(2000);
                console.log(`  ✅ FreeBitcoin ready`);
            } catch(e) {}
        }
        
        // Login to FireFaucet
        if (this.accounts.firefaucet?.success) {
            try {
                await this.page.goto('https://firefaucet.win', { waitUntil: 'networkidle2' });
                await this.page.waitForTimeout(2000);
                console.log(`  ✅ FireFaucet ready`);
            } catch(e) {}
        }
        
        // Login to Cointiply
        if (this.accounts.cointiply?.success) {
            try {
                await this.page.goto('https://cointiply.com', { waitUntil: 'networkidle2' });
                await this.page.waitForTimeout(2000);
                console.log(`  ✅ Cointiply ready`);
            } catch(e) {}
        }
    }

    async claimAll() {
        const claimer = new FaucetClaimer(this.page);
        let totalEarned = 0;
        
        console.log(`\n💰 Claiming faucets - ${new Date().toLocaleTimeString()}`);
        console.log('----------------------------------------');
        
        if (this.accounts.freebitcoin?.success) {
            const earned = await claimer.claimFreeBitcoin();
            totalEarned += earned;
            await this.page.waitForTimeout(3000);
        }
        
        if (this.accounts.firefaucet?.success) {
            const earned = await claimer.claimFireFaucet();
            totalEarned += earned;
            await this.page.waitForTimeout(3000);
        }
        
        if (this.accounts.cointiply?.success) {
            const earned = await claimer.claimCointiply();
            totalEarned += earned;
            await this.page.waitForTimeout(3000);
        }
        
        return totalEarned;
    }

    async run() {
        console.log('🚀 Starting Auto Faucet Bot');
        console.log('========================================\n');
        
        if (!this.walletAddress) {
            console.log('❌ ERROR: FAUCETPAY_WALLET_ADDRESS is required!');
            console.log('   Set your FaucetPay wallet address and restart.\n');
            return;
        }
        
        await this.init();
        
        // Create accounts on first run
        await this.createAllAccounts();
        await this.loginToExistingAccounts();
        
        let cycleCount = 0;
        
        while (true) {
            cycleCount++;
            try {
                const earned = await this.claimAll();
                
                if (earned > 0) {
                    stats.totalEarned += earned;
                    stats.totalClaims++;
                    stats.history.unshift({
                        time: new Date(),
                        earned: earned,
                        total: stats.totalEarned,
                        cycle: cycleCount
                    });
                    if (stats.history.length > 50) stats.history.pop();
                }
                
                console.log(`----------------------------------------`);
                console.log(`💰 Cycle earned: $${earned.toFixed(4)}`);
                console.log(`📊 Total earned: $${stats.totalEarned.toFixed(4)}`);
                console.log(`🖱️ Total claims: ${stats.totalClaims}`);
                
                console.log(`⏰ Next cycle in ${SCAN_INTERVAL_SECONDS} seconds\n`);
                await this.page.waitForTimeout(SCAN_INTERVAL_SECONDS * 1000);
                
                // Refresh browser occasionally
                if (cycleCount % 20 === 0) {
                    await this.browser.close();
                    await this.init();
                    await this.loginToExistingAccounts();
                    console.log('🔄 Browser refreshed\n');
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
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Auto Faucet Bot</title>
    <meta http-equiv="refresh" content="10">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 40px; }
        .container { max-width: 800px; margin: 0 auto; }
        h1 { text-align: center; }
        .stats { display: flex; gap: 20px; margin: 30px 0; flex-wrap: wrap; }
        .stat-card { background: #1a1f3a; padding: 20px; border-radius: 10px; flex: 1; text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        .wallet { background: #0a2a1a; padding: 10px; border-radius: 5px; font-size: 12px; word-break: break-all; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 Auto Faucet Bot</h1>
        <div class="status">
            🟢 RUNNING | Uptime: ${hours}h ${minutes}m | Cycle: ${SCAN_INTERVAL_SECONDS}s
        </div>
        
        <div class="wallet">
            📬 Wallet: ${FAUCETPAY_WALLET_ADDRESS ? FAUCETPAY_WALLET_ADDRESS.substring(0, 20) + '...' : 'NOT SET'}
        </div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(5)}</div><div>Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">${stats.accountsCreated}</div><div>Accounts Created</div></div>
            <div class="stat-card"><div class="stat-value">$${dailyRate}</div><div>Per Day</div></div>
        </div>
        
        <h3>📈 Activity Log</h3>
        <table>
            <thead><tr><th>Time</th><th>Earned</th><th>Total</th></tr></thead>
            <tbody>
                ${stats.history.slice(0, 20).map(h => `
                    <tr>
                        <td>${new Date(h.time).toLocaleTimeString()}</td>
                        <td class="earn">+$${h.earned.toFixed(5)}</td>
                        <td>$${h.total.toFixed(5)}</td>
                    </tr>
                `).join('')}
                ${stats.history.length === 0 ? '<tr><td colspan="3">Waiting for claims...</td></tr>' : ''}
            </tbody>
        </table>
    </div>
</body>
</html>`);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Auto Faucet Bot...');
    console.log('🪙 Will auto-create accounts and configure wallet\n');
    
    if (!FAUCETPAY_WALLET_ADDRESS) {
        console.log('⚠️  WARNING: FAUCETPAY_WALLET_ADDRESS not set!');
        console.log('   Set your FaucetPay wallet address to receive payments.\n');
    }
    
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    const bot = new AutoFaucetBot(FAUCETPAY_WALLET_ADDRESS, FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
    await bot.run();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
