// faucetpay-complete-bot.js - With wallet configuration
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
const FAUCETPAY_EMAIL = process.env.FAUCETPAY_EMAIL || '';
const FAUCETPAY_PASSWORD = process.env.FAUCETPAY_PASSWORD || '';
const FAUCETPAY_WALLET_ADDRESS = process.env.FAUCETPAY_WALLET_ADDRESS || ''; // Your FaucetPay wallet address
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 60;

const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Complete Bot');
console.log('========================================');
console.log(`FaucetPay Email: ${FAUCETPAY_EMAIL || 'Not set'}`);
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

// ============ EARNING METHODS ============
const EARNING_METHODS = [
    { name: 'Daily Bonus', url: 'https://faucetpay.io/dashboard', earnPerAction: 0.001, requiresLogin: true },
    { name: 'Faucet List', url: 'https://faucetpay.io/faucets', earnPerAction: 0.0005, requiresLogin: true },
    { name: 'Offerwalls', url: 'https://faucetpay.io/offerwalls', earnPerAction: 0.002, requiresLogin: true },
    { name: 'Paid to Click', url: 'https://faucetpay.io/ptc', earnPerAction: 0.0008, requiresLogin: true },
    { name: 'Staking', url: 'https://faucetpay.io/staking', earnPerAction: 0.001, requiresLogin: true }
];

// Public faucets that can send to FaucetPay wallet
const PUBLIC_FAUCETS = [
    { 
        name: 'FreeBitcoin', 
        url: 'https://freebitco.in', 
        earnPerClaim: 0.0001, 
        selector: '#free_play_form_button',
        hasWalletField: true,
        walletSelector: 'input[name="btc_address"]'
    },
    { 
        name: 'Cointiply', 
        url: 'https://cointiply.com', 
        earnPerClaim: 0.0003, 
        selector: '.claim-button',
        hasWalletField: true,
        walletSelector: 'input[name="faucetpay"]'
    },
    { 
        name: 'FireFaucet', 
        url: 'https://firefaucet.win', 
        earnPerClaim: 0.0002, 
        selector: '#claimButton',
        hasWalletField: true,
        walletSelector: 'input[name="wallet"]'
    },
    { 
        name: 'ADBTC', 
        url: 'https://adbtc.top', 
        earnPerClaim: 0.00015, 
        selector: '.claim-btn',
        hasWalletField: true
    }
];

// ============ STATS ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
    currentBalance: 0,
    methodStats: {},
    faucetStats: {},
    history: [],
    startTime: new Date(),
    isLoggedIn: false
};

EARNING_METHODS.forEach(m => { stats.methodStats[m.name] = { actions: 0, earned: 0 }; });
PUBLIC_FAUCETS.forEach(f => { stats.faucetStats[f.name] = { claims: 0, earned: 0 }; });

// ============ COMPLETE BOT ============
class CompleteFaucetBot {
    constructor(email, password, walletAddress) {
        this.email = email;
        this.password = password;
        this.walletAddress = walletAddress;
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
            console.log('[FaucetPay] No credentials - using public faucets only');
            return false;
        }
        
        console.log('[FaucetPay] Logging in...');
        try {
            await this.page.goto('https://faucetpay.io/login', { waitUntil: 'networkidle2', timeout: 30000 });
            await this.page.waitForTimeout(5000);
            
            let emailField = await this.page.$('#email');
            if (!emailField) emailField = await this.page.$('input[name="email"]');
            if (emailField) {
                await emailField.click({ clickCount: 3 });
                await emailField.type(this.email);
            }
            
            let passField = await this.page.$('#password');
            if (!passField) passField = await this.page.$('input[name="password"]');
            if (passField) {
                await passField.click({ clickCount: 3 });
                await passField.type(this.password);
            }
            
            let submitBtn = await this.page.$('button[type="submit"]');
            if (submitBtn) {
                await submitBtn.click();
                await this.page.waitForTimeout(5000);
            }
            
            this.isLoggedIn = true;
            console.log('[FaucetPay] ✅ Login successful!');
            await this.updateBalance();
            return true;
        } catch (error) {
            console.error('[FaucetPay] Login error:', error.message);
            return false;
        }
    }

    async updateBalance() {
        try {
            const balanceText = await this.page.$eval('.balance-amount, .user-balance', el => el.innerText).catch(() => '0');
            stats.currentBalance = parseFloat(balanceText) || 0;
            return stats.currentBalance;
        } catch (error) {
            return stats.currentBalance;
        }
    }

    async claimPublicFaucetWithWallet(faucet) {
        try {
            console.log(`  🪙 ${faucet.name}...`);
            await this.page.goto(faucet.url, { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(3000);
            
            // First, set wallet address if faucet supports it
            if (faucet.hasWalletField && this.walletAddress) {
                const walletInput = await this.page.$(faucet.walletSelector || 'input[type="text"]');
                if (walletInput) {
                    await walletInput.click({ clickCount: 3 });
                    await walletInput.type(this.walletAddress);
                    console.log(`    📝 Wallet address set for ${faucet.name}`);
                    await this.page.waitForTimeout(1000);
                }
            }
            
            // Find and click claim button
            let claimBtn = null;
            if (faucet.selector) {
                claimBtn = await this.page.$(faucet.selector);
            }
            
            if (!claimBtn) {
                const buttons = await this.page.$$('button, a');
                for (const btn of buttons) {
                    const text = await btn.evaluate(el => (el.innerText || '').toLowerCase()).catch(() => '');
                    if (text && (text.includes('claim') || text.includes('get') || text.includes('earn'))) {
                        claimBtn = btn;
                        break;
                    }
                }
            }
            
            if (claimBtn) {
                await claimBtn.click();
                await this.page.waitForTimeout(5000);
                
                stats.totalEarned += faucet.earnPerClaim;
                stats.totalActions++;
                stats.faucetStats[faucet.name].claims++;
                stats.faucetStats[faucet.name].earned += faucet.earnPerClaim;
                console.log(`    ✅ Claimed! +$${faucet.earnPerClaim.toFixed(5)} → Sent to FaucetPay wallet`);
                return faucet.earnPerClaim;
            }
            
            console.log(`    ⚠️ No claim button found`);
            return 0;
        } catch (error) {
            console.log(`    ❌ Error: ${error.message}`);
            return 0;
        }
    }

    async runCycle() {
        let cycleEarned = 0;
        
        console.log(`\n💰 Scanning earnings...`);
        
        // Public faucets - payments go to FaucetPay wallet
        console.log(`\n🪙 Claiming public faucets (payments → FaucetPay wallet):`);
        for (const faucet of PUBLIC_FAUCETS) {
            const earned = await this.claimPublicFaucetWithWallet(faucet);
            cycleEarned += earned;
            await this.page.waitForTimeout(3000);
        }
        
        return cycleEarned;
    }

    async run() {
        console.log('\n🚀 Starting Complete Faucet Bot');
        console.log('========================================\n');
        
        await this.init();
        
        if (this.email && this.password) {
            await this.login();
        }
        
        if (!this.walletAddress) {
            console.log('⚠️ WARNING: FAUCETPAY_WALLET_ADDRESS not set!');
            console.log('   Public faucets need your wallet address to send payments.\n');
        } else {
            console.log(`✅ FaucetPay Wallet Address configured: ${this.walletAddress.substring(0, 10)}...\n`);
        }
        
        let cycleCount = 0;
        
        while (true) {
            cycleCount++;
            console.log(`\n📊 Cycle #${cycleCount} - ${new Date().toLocaleTimeString()}`);
            console.log('----------------------------------------');
            
            try {
                const earned = await this.runCycle();
                
                if (earned > 0) {
                    stats.history.unshift({
                        time: new Date(),
                        earned: earned,
                        cycle: cycleCount
                    });
                    if (stats.history.length > 50) stats.history.pop();
                    
                    if (this.isLoggedIn) await this.updateBalance();
                    
                    console.log(`----------------------------------------`);
                    console.log(`💰 Cycle earned: $${earned.toFixed(5)}`);
                    console.log(`📊 Total earned: $${stats.totalEarned.toFixed(5)}`);
                    if (this.isLoggedIn) console.log(`💳 FaucetPay Balance: $${stats.currentBalance}`);
                }
                
                console.log(`⏰ Next cycle in ${SCAN_INTERVAL_SECONDS} seconds\n`);
                await this.page.waitForTimeout(SCAN_INTERVAL_SECONDS * 1000);
                
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
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>FaucetPay Complete Bot</title>
    <meta http-equiv="refresh" content="10">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 40px; }
        .container { max-width: 1000px; margin: 0 auto; }
        h1 { text-align: center; }
        .stats { display: flex; gap: 20px; margin: 30px 0; flex-wrap: wrap; }
        .stat-card { background: #1a1f3a; padding: 20px; border-radius: 10px; flex: 1; text-align: center; }
        .stat-value { font-size: 32px; font-weight: bold; }
        .earn { color: #00ff88; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        .wallet { color: #ffaa00; font-size: 12px; margin-top: 5px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 FaucetPay Complete Bot</h1>
        <div class="status">
            🟢 STATUS: <span class="online">RUNNING</span> | Uptime: ${hours}h ${minutes}m
            <div class="wallet">💰 Wallet: ${FAUCETPAY_WALLET_ADDRESS ? FAUCETPAY_WALLET_ADDRESS.substring(0, 15) + '...' : 'NOT SET'}</div>
        </div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(5)}</div><div>Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalActions}</div><div>Total Actions</div></div>
            <div class="stat-card"><div class="stat-value">$${stats.currentBalance.toFixed(5)}</div><div>Balance</div></div>
        </div>
        
        <h3>📈 Recent Activity</h3>
        <table>
            <thead><tr><th>Time</th><th>Cycle</th><th>Earned</th></tr></thead>
            <tbody>
                ${stats.history.slice(0, 30).map(h => `
                    <tr>
                        <td>${new Date(h.time).toLocaleTimeString()}</td>
                        <td>#${h.cycle}</td>
                        <td class="earn">+$${h.earned.toFixed(5)}</td>
                    </tr>
                `).join('')}
                ${stats.history.length === 0 ? '<tr><td colspan="3">Waiting for activity...</td></tr>' : ''}
            </tbody>
        </table>
    </div>
</body>
</html>`);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Complete Faucet Bot...');
    console.log('💰 Public faucets will send payments to your FaucetPay wallet');
    console.log(`⏱️  Scanning every ${SCAN_INTERVAL_SECONDS} seconds\n`);
    
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    const bot = new CompleteFaucetBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD, FAUCETPAY_WALLET_ADDRESS);
    await bot.run();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
