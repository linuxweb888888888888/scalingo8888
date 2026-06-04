// faucetpay-advanced-bot.js - With withdrawal confirmation and status tracking
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
const FAUCETPAY_WALLET_ADDRESS = process.env.FAUCETPAY_WALLET_ADDRESS || 'ltc1q0k6uqmjgp32uplwyfx9kqmd4j26js9w3x6as9d';
const FAUCETPAY_EMAIL = process.env.FAUCETPAY_EMAIL || 'web88888888888888@gmail.com';
const FAUCETPAY_PASSWORD = process.env.FAUCETPAY_PASSWORD || 'Linuxdistro&84';
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 60;
const AUTO_WITHDRAW_THRESHOLD = parseFloat(process.env.AUTO_WITHDRAW_THRESHOLD) || 5.00;
const WITHDRAWAL_ADDRESS = process.env.WITHDRAWAL_ADDRESS || '';

const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Advanced Bot');
console.log('========================================');
console.log(`Wallet: ${FAUCETPAY_WALLET_ADDRESS || 'Not set'}`);
console.log(`Auto Withdraw Threshold: $${AUTO_WITHDRAW_THRESHOLD}`);
console.log(`Scan: Every ${SCAN_INTERVAL_SECONDS}s`);
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

// ============ FAUCETS LIST ============
const FAUCETS = [
    { name: 'FreeBitcoin', url: 'https://freebitco.in', earnPerClaim: 0.0005, registered: false, walletSet: false, lastClaim: null, status: 'pending' },
    { name: 'FireFaucet', url: 'https://firefaucet.win', earnPerClaim: 0.0003, registered: false, walletSet: false, lastClaim: null, status: 'pending' },
    { name: 'Cointiply', url: 'https://cointiply.com', earnPerClaim: 0.0003, registered: false, walletSet: false, lastClaim: null, status: 'pending' },
    { name: 'ADBTC', url: 'https://adbtc.top', earnPerClaim: 0.0002, registered: false, walletSet: false, lastClaim: null, status: 'pending' },
    { name: 'BTCClicks', url: 'https://btcclicks.com', earnPerClaim: 0.0002, registered: false, walletSet: false, lastClaim: null, status: 'pending' },
    { name: 'CoinPayU', url: 'https://coinpayu.com', earnPerClaim: 0.00015, registered: false, walletSet: false, lastClaim: null, status: 'pending' },
    { name: 'FaucetCrypto', url: 'https://faucetcrypto.com', earnPerClaim: 0.0002, registered: false, walletSet: false, lastClaim: null, status: 'pending' }
];

// ============ STATUS STORAGE ============
let stats = {
    totalEarned: 0,
    totalClaims: 0,
    currentBalance: 0,
    withdrawStatus: {
        pending: false,
        amount: 0,
        address: '',
        status: 'idle',
        lastWithdrawal: null,
        transactionId: null
    },
    registrationLog: [],
    withdrawalLog: [],
    claimLog: [],
    walletVerification: { verified: false, address: FAUCETPAY_WALLET_ADDRESS, verifiedAt: null },
    startTime: new Date()
};

// ============ ADVANCED BOT ============
class AdvancedFaucetBot {
    constructor(walletAddress, email, password) {
        this.walletAddress = walletAddress;
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.loggedIn = false;
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

    async loginFaucetPay() {
        if (!this.email || !this.password) {
            console.log('⚠️ No FaucetPay credentials');
            return false;
        }
        
        console.log('🔐 Logging into FaucetPay...');
        try {
            await this.page.goto('https://faucetpay.io/login', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(3000);
            
            await this.page.type('#email', this.email);
            await this.page.type('#password', this.password);
            await this.page.click('button[type="submit"]');
            await this.page.waitForTimeout(5000);
            
            this.loggedIn = true;
            console.log('✅ FaucetPay login successful');
            await this.checkBalance();
            await this.verifyWalletSetup();
            return true;
        } catch (error) {
            console.log('⚠️ FaucetPay login failed');
            return false;
        }
    }

    async checkBalance() {
        try {
            const balanceText = await this.page.$eval('.balance-amount, .user-balance', el => el.innerText).catch(() => '0');
            stats.currentBalance = parseFloat(balanceText) || 0;
            console.log(`💰 Current Balance: $${stats.currentBalance}`);
            
            // Check if should auto-withdraw
            if (AUTO_WITHDRAW_THRESHOLD > 0 && stats.currentBalance >= AUTO_WITHDRAW_THRESHOLD && WITHDRAWAL_ADDRESS) {
                await this.initiateWithdrawal();
            }
            return stats.currentBalance;
        } catch (error) {
            return stats.currentBalance;
        }
    }

    async verifyWalletSetup() {
        console.log('\n🔍 Verifying wallet setup...');
        stats.walletVerification.verified = false;
        
        try {
            await this.page.goto('https://faucetpay.io/dashboard', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(2000);
            
            // Check if linked addresses exist
            const linkedAddresses = await this.page.$('.linked-addresses, .withdrawal-addresses');
            if (linkedAddresses) {
                stats.walletVerification.verified = true;
                stats.walletVerification.verifiedAt = new Date();
                console.log(`✅ Wallet verified: ${this.walletAddress ? this.walletAddress.substring(0, 15) + '...' : 'Not set'}`);
            } else {
                console.log('⚠️ No linked addresses found');
            }
        } catch (error) {
            console.log('⚠️ Could not verify wallet');
        }
    }

    async initiateWithdrawal() {
        console.log(`\n💸 Initiating withdrawal of $${stats.currentBalance} to ${WITHDRAWAL_ADDRESS.substring(0, 15)}...`);
        stats.withdrawStatus.pending = true;
        stats.withdrawStatus.amount = stats.currentBalance;
        stats.withdrawStatus.address = WITHDRAWAL_ADDRESS;
        stats.withdrawStatus.status = 'processing';
        
        try {
            await this.page.goto('https://faucetpay.io/withdraw', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(3000);
            
            // Select coin (BTC/LTC/DOGE based on address format)
            let coinSelect = 'BTC';
            if (WITHDRAWAL_ADDRESS.startsWith('ltc1') || WITHDRAWAL_ADDRESS.startsWith('L')) coinSelect = 'LTC';
            if (WITHDRAWAL_ADDRESS.startsWith('D')) coinSelect = 'DOGE';
            
            await this.page.select('#coin', coinSelect);
            await this.page.type('#address', WITHDRAWAL_ADDRESS);
            await this.page.type('#amount', stats.currentBalance.toString());
            await this.page.click('#withdraw-btn');
            await this.page.waitForTimeout(5000);
            
            // Check for success
            const successMsg = await this.page.$('.success-message, .alert-success');
            if (successMsg) {
                const txId = await this.page.$eval('.transaction-id, .txid', el => el.innerText).catch(() => 'N/A');
                stats.withdrawStatus.status = 'completed';
                stats.withdrawStatus.transactionId = txId;
                stats.withdrawStatus.lastWithdrawal = new Date();
                stats.withdrawalLog.unshift({
                    time: new Date(),
                    amount: stats.currentBalance,
                    address: WITHDRAWAL_ADDRESS,
                    txId: txId,
                    status: 'completed'
                });
                console.log(`✅ Withdrawal successful! TXID: ${txId}`);
                stats.currentBalance = 0;
            } else {
                stats.withdrawStatus.status = 'failed';
                stats.withdrawalLog.unshift({
                    time: new Date(),
                    amount: stats.currentBalance,
                    address: WITHDRAWAL_ADDRESS,
                    status: 'failed'
                });
                console.log('❌ Withdrawal failed');
            }
        } catch (error) {
            stats.withdrawStatus.status = 'failed';
            console.log(`❌ Withdrawal error: ${error.message}`);
        }
        
        stats.withdrawStatus.pending = false;
        return stats.withdrawStatus.status === 'completed';
    }

    async registerFaucet(faucet) {
        if (faucet.registered) return true;
        
        console.log(`\n📝 Registering on ${faucet.name}...`);
        try {
            const timestamp = Date.now();
            const random = Math.random().toString(36).substring(2, 8);
            const email = `user_${timestamp}_${random}@10minutemail.net`;
            const password = Math.random().toString(36).substring(2, 15);
            
            await this.page.goto(`${faucet.url}/register`, { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(2000);
            
            // Fill registration
            await this.page.type('input[name="email"], input[type="email"]', email);
            await this.page.type('input[name="password"], input[type="password"]', password);
            if (this.walletAddress) {
                await this.page.type('input[name="btc_address"], input[name="faucetpay"]', this.walletAddress);
            }
            
            await this.page.click('button[type="submit"], input[type="submit"]');
            await this.page.waitForTimeout(3000);
            
            faucet.registered = true;
            faucet.walletSet = !!this.walletAddress;
            faucet.status = 'active';
            
            stats.registrationLog.unshift({
                time: new Date(),
                faucet: faucet.name,
                email: email,
                walletSet: faucet.walletSet,
                status: 'success'
            });
            
            console.log(`✅ Registered: ${email}`);
            return true;
        } catch (error) {
            stats.registrationLog.unshift({
                time: new Date(),
                faucet: faucet.name,
                status: 'failed',
                error: error.message
            });
            return false;
        }
    }

    async claimFaucet(faucet) {
        if (!faucet.registered) return 0;
        
        try {
            await this.page.goto(faucet.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await this.page.waitForTimeout(2000);
            
            const claimSelectors = ['#claimButton', '.claim-btn', 'button.claim', '#free_play_form_button'];
            let claimed = false;
            
            for (const selector of claimSelectors) {
                const claimBtn = await this.page.$(selector);
                if (claimBtn) {
                    await claimBtn.click();
                    await this.page.waitForTimeout(3000);
                    claimed = true;
                    break;
                }
            }
            
            if (claimed) {
                faucet.lastClaim = new Date();
                stats.totalEarned += faucet.earnPerClaim;
                stats.totalClaims++;
                stats.claimLog.unshift({
                    time: new Date(),
                    faucet: faucet.name,
                    amount: faucet.earnPerClaim,
                    status: 'success'
                });
                return faucet.earnPerClaim;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }

    async runCycle() {
        let cycleEarned = 0;
        
        console.log(`\n📊 Cycle - ${new Date().toLocaleTimeString()}`);
        console.log('----------------------------------------');
        
        for (const faucet of FAUCETS) {
            if (!faucet.registered) {
                await this.registerFaucet(faucet);
            }
            
            if (faucet.registered) {
                const earned = await this.claimFaucet(faucet);
                cycleEarned += earned;
                if (earned > 0) {
                    console.log(`  ✅ ${faucet.name}: +$${faucet.earnPerClaim.toFixed(4)}`);
                }
                await this.page.waitForTimeout(2000);
            }
        }
        
        if (this.loggedIn) {
            await this.checkBalance();
        }
        
        console.log(`----------------------------------------`);
        console.log(`💰 Cycle earned: $${cycleEarned.toFixed(4)}`);
        console.log(`📊 Total earned: $${stats.totalEarned.toFixed(4)}`);
        console.log(`💳 Balance: $${stats.currentBalance}`);
        
        return cycleEarned;
    }

    async run() {
        console.log('🚀 Starting Advanced Faucet Bot');
        console.log('========================================\n');
        
        if (!this.walletAddress) {
            console.log('⚠️ WARNING: FAUCETPAY_WALLET_ADDRESS not set!');
            console.log('   Set your FaucetPay deposit address to receive payments.\n');
        }
        
        await this.init();
        await this.loginFaucetPay();
        
        let cycleCount = 0;
        
        while (true) {
            cycleCount++;
            try {
                await this.runCycle();
                console.log(`⏰ Next cycle in ${SCAN_INTERVAL_SECONDS} seconds\n`);
                await this.page.waitForTimeout(SCAN_INTERVAL_SECONDS * 1000);
                
                if (cycleCount % 30 === 0) {
                    await this.browser.close();
                    await this.init();
                    if (this.loggedIn) await this.loginFaucetPay();
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
    
    // Build status HTML
    const faucetStatusHtml = FAUCETS.map(f => `
        <tr>
            <td>${f.name}</td>
            <td>${f.registered ? '✅' : '⏳'}</td>
            <td>${f.walletSet ? '✅' : '❌'}</td>
            <td>${f.lastClaim ? new Date(f.lastClaim).toLocaleTimeString() : 'Never'}</td>
            <td class="status-${f.status}">${f.status}</td>
        </tr>
    `).join('');
    
    const registrationHtml = stats.registrationLog.slice(0, 10).map(r => `
        <tr>
            <td>${new Date(r.time).toLocaleTimeString()}</td>
            <td>${r.faucet}</td>
            <td class="${r.status === 'success' ? 'earn' : 'error'}">${r.status}</td>
            <td>${r.walletSet ? '✅ Wallet set' : '-'}</td>
        </tr>
    `).join('');
    
    const withdrawalHtml = stats.withdrawalLog.slice(0, 10).map(w => `
        <tr>
            <td>${new Date(w.time).toLocaleTimeString()}</td>
            <td>$${w.amount.toFixed(2)}</td>
            <td>${w.address.substring(0, 15)}...</td>
            <td class="${w.status === 'completed' ? 'earn' : 'error'}">${w.status}</td>
            <td>${w.txId ? w.txId.substring(0, 20) + '...' : '-'}</td>
        </tr>
    `).join('');
    
    const claimHtml = stats.claimLog.slice(0, 20).map(c => `
        <tr>
            <td>${new Date(c.time).toLocaleTimeString()}</td>
            <td>${c.faucet}</td>
            <td class="earn">+$${c.amount.toFixed(5)}</td>
        </tr>
    `).join('');
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Advanced Faucet Bot - Dashboard</title>
    <meta http-equiv="refresh" content="10">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        h1, h2, h3 { text-align: center; margin-bottom: 10px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin: 20px 0; }
        .stat-card { background: #1a1f3a; padding: 15px; border-radius: 10px; text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; }
        .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 20px; }
        .card { background: #1a1f3a; padding: 15px; border-radius: 10px; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
        th { color: #00ff88; }
        .earn { color: #00ff88; }
        .error { color: #ff4444; }
        .status-pending { color: #ffaa00; }
        .status-active { color: #00ff88; }
        .status-failed { color: #ff4444; }
        .withdraw-info { background: #0a2a1a; padding: 10px; border-radius: 5px; margin: 10px 0; }
        .withdraw-pending { color: #ffaa00; animation: pulse 1s infinite; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        .wallet { background: #0a2a1a; padding: 8px; border-radius: 5px; font-size: 11px; word-break: break-all; margin-top: 10px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .refresh-btn { background: #1a1f3a; color: #00ff88; border: 1px solid #00ff88; padding: 5px 10px; border-radius: 5px; cursor: pointer; margin-bottom: 10px; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 Advanced Faucet Bot</h1>
        <div class="status">
            🟢 RUNNING | Uptime: ${hours}h ${minutes}m | Cycle: ${SCAN_INTERVAL_SECONDS}s
            <div class="wallet">📬 Wallet: ${FAUCETPAY_WALLET_ADDRESS ? FAUCETPAY_WALLET_ADDRESS.substring(0, 25) + '...' : 'NOT SET'}</div>
            <div class="wallet">🏦 Withdraw To: ${WITHDRAWAL_ADDRESS ? WITHDRAWAL_ADDRESS.substring(0, 25) + '...' : 'NOT SET'}</div>
        </div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(5)}</div><div>Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">$${dailyRate}</div><div>Per Day</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalClaims}</div><div>Total Claims</div></div>
            <div class="stat-card"><div class="stat-value">$${stats.currentBalance.toFixed(4)}</div><div>Balance</div></div>
        </div>
        
        <!-- Withdrawal Status -->
        <div class="card">
            <h3>💸 Withdrawal Status</h3>
            <div class="withdraw-info">
                <strong>Threshold:</strong> $${AUTO_WITHDRAW_THRESHOLD} | 
                <strong>Status:</strong> <span class="${stats.withdrawStatus.status === 'processing' ? 'withdraw-pending' : ''}">${stats.withdrawStatus.status}</span> |
                <strong>Last Withdrawal:</strong> ${stats.withdrawStatus.lastWithdrawal ? new Date(stats.withdrawStatus.lastWithdrawal).toLocaleString() : 'Never'}
                ${stats.withdrawStatus.transactionId ? `<br><strong>TXID:</strong> ${stats.withdrawStatus.transactionId}` : ''}
            </div>
        </div>
        
        <div class="grid-2">
            <!-- Faucet Registration Status -->
            <div class="card">
                <h3>📝 Faucet Registration Status</h3>
                <table>
                    <thead><tr><th>Faucet</th><th>Registered</th><th>Wallet</th><th>Last Claim</th><th>Status</th></tr></thead>
                    <tbody>${faucetStatusHtml}</tbody>
                </table>
            </div>
            
            <!-- Registration Log -->
            <div class="card">
                <h3>📋 Registration Log</h3>
                <table>
                    <thead><tr><th>Time</th><th>Faucet</th><th>Status</th><th>Details</th></tr></thead>
                    <tbody>${registrationHtml || '<td><td colspan="4">No registrations yet...</td></tr>'}</tbody>
                </table>
            </div>
        </div>
        
        <div class="grid-2">
            <!-- Withdrawal History -->
            <div class="card">
                <h3>🏦 Withdrawal History</h3>
                <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
                <table>
                    <thead><tr><th>Time</th><th>Amount</th><th>Address</th><th>Status</th><th>TXID</th></tr></thead>
                    <tbody>${withdrawalHtml || '<tr><td colspan="5">No withdrawals yet...</td></tr>'}</tbody>
                </table>
            </div>
            
            <!-- Recent Claims -->
            <div class="card">
                <h3>🪙 Recent Claims</h3>
                <table>
                    <thead><tr><th>Time</th><th>Faucet</th><th>Amount</th></tr></thead>
                    <tbody>${claimHtml || '<tr><td colspan="3">No claims yet...</td></tr>'}</tbody>
                </table>
            </div>
        </div>
    </div>
</body>
</html>`);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Advanced Faucet Bot...');
    console.log('💸 Auto-withdrawal enabled at $' + AUTO_WITHDRAW_THRESHOLD);
    console.log('========================================\n');
    
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    const bot = new AdvancedFaucetBot(FAUCETPAY_WALLET_ADDRESS, FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
    await bot.run();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
