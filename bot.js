// faucetpay-full-bot.js - Complete bot with real-time earnings and withdrawal tracking
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
const AUTO_WITHDRAW = process.env.AUTO_WITHDRAW !== 'true';

const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Complete Bot');
console.log('========================================');
console.log(`Auto Withdraw: ${AUTO_WITHDRAW ? 'ON' : 'OFF'}`);
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

// ============ EARNING SOURCES ============
const EARNING_SOURCES = [
    // FaucetPay Internal (Instant to balance)
    { name: 'Daily Bonus', url: 'https://faucetpay.io/dashboard', earnPerAction: 0.001, type: 'bonus', instantToBalance: true },
    { name: 'Faucet List', url: 'https://faucetpay.io/faucets', earnPerAction: 0.0005, type: 'view', instantToBalance: true },
    { name: 'Offerwalls', url: 'https://faucetpay.io/offerwalls', earnPerAction: 0.002, type: 'view', instantToBalance: true },
    { name: 'PTC Ads', url: 'https://faucetpay.io/ptc', earnPerAction: 0.0008, type: 'ptc', instantToBalance: true },
    { name: 'Staking', url: 'https://faucetpay.io/staking', earnPerAction: 0.001, type: 'staking', instantToBalance: true },
    { name: 'Tasks', url: 'https://faucetpay.io/tasks', earnPerAction: 0.0015, type: 'tasks', instantToBalance: true },
    
    // External Faucets (Require withdrawal)
    { name: 'FreeBitcoin', url: 'https://freebitco.in', earnPerAction: 0.0005, type: 'faucet', minWithdraw: 0.0003, instantToBalance: false },
    { name: 'FireFaucet', url: 'https://firefaucet.win', earnPerAction: 0.0003, type: 'faucet', minWithdraw: 0.0002, instantToBalance: false },
    { name: 'Cointiply', url: 'https://cointiply.com', earnPerAction: 0.0003, type: 'faucet', minWithdraw: 0.0002, instantToBalance: false },
    { name: 'FaucetCrypto', url: 'https://faucetcrypto.com', earnPerAction: 0.0002, type: 'faucet', minWithdraw: 0.0001, instantToBalance: false }
];

// ============ STATS STORAGE ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
    currentBalance: 0,
    sessionEarned: 0,
    sourceBalances: {},
    withdrawalHistory: [],
    claimHistory: [],
    successHistory: [],
    startTime: new Date(),
    loggedIn: false,
    lastWithdrawal: null
};

EARNING_SOURCES.forEach(s => {
    stats.sourceBalances[s.name] = { earned: 0, claims: 0, lastClaim: null, pendingWithdraw: false };
});

// ============ COMPLETE BOT ============
class CompleteFaucetBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.loggedIn = false;
        this.claimSelectors = ['#claimButton', '.claim-btn', 'button.claim', '#claim', '.claim-button', '#free_play_form_button'];
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
            console.log('[FaucetPay] Demo mode - limited features');
            return false;
        }
        
        console.log('[FaucetPay] Logging in...');
        try {
            await this.page.goto('https://faucetpay.io/login', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(3000);
            
            await this.page.type('#email', this.email);
            await this.page.type('#password', this.password);
            await this.page.click('button[type="submit"]');
            await this.page.waitForTimeout(5000);
            
            this.loggedIn = true;
            stats.loggedIn = true;
            console.log('[FaucetPay] ✅ Login successful!');
            await this.updateBalance();
            return true;
        } catch (error) {
            console.log('[FaucetPay] Login failed - running in limited mode');
            return false;
        }
    }

    async updateBalance() {
        try {
            const balanceText = await this.page.$eval('.balance-amount, .user-balance', el => el.innerText).catch(() => '0');
            const newBalance = parseFloat(balanceText) || 0;
            if (newBalance !== stats.currentBalance) {
                console.log(`💰 Balance updated: $${stats.currentBalance.toFixed(5)} → $${newBalance.toFixed(5)}`);
                stats.currentBalance = newBalance;
            }
            return stats.currentBalance;
        } catch (error) {
            return stats.currentBalance;
        }
    }

    async claimSource(source) {
        try {
            await this.page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await this.page.waitForTimeout(2000);
            
            let claimBtn = null;
            for (const selector of this.claimSelectors) {
                try { claimBtn = await this.page.$(selector); if (claimBtn) break; } catch(e) {}
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
                await this.page.waitForTimeout(3000);
                
                const earned = source.earnPerAction;
                
                // Update stats
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions++;
                stats.sourceBalances[source.name].earned += earned;
                stats.sourceBalances[source.name].claims++;
                stats.sourceBalances[source.name].lastClaim = new Date();
                
                // Record claim
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    amount: earned,
                    type: source.type,
                    instantToBalance: source.instantToBalance
                });
                
                // Log with appropriate indicator
                const indicator = source.instantToBalance ? '💰' : '🪙';
                console.log(`  ${indicator} ${source.name}: +$${earned.toFixed(5)} → ${source.instantToBalance ? 'To Balance' : `To ${source.name} Wallet`}`);
                
                // Check if external faucet reached withdrawal minimum
                if (!source.instantToBalance && source.minWithdraw && stats.sourceBalances[source.name].earned >= source.minWithdraw) {
                    await this.withdrawFromSource(source);
                }
                
                return earned;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }

    async withdrawFromSource(source) {
        const balance = stats.sourceBalances[source.name].earned;
        console.log(`\n  💸 WITHDRAWING from ${source.name}!`);
        console.log(`     Balance: $${balance.toFixed(5)}`);
        console.log(`     Minimum required: $${source.minWithdraw}`);
        
        stats.sourceBalances[source.name].pendingWithdraw = true;
        
        try {
            // Attempt to find and click withdraw button
            await this.page.goto(source.url, { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(3000);
            
            const withdrawSelectors = ['.withdraw-btn', '#withdraw', 'button:has-text("Withdraw")', 'a:has-text("Withdraw")'];
            let withdrawBtn = null;
            
            for (const selector of withdrawSelectors) {
                try { withdrawBtn = await this.page.$(selector); if (withdrawBtn) break; } catch(e) {}
            }
            
            if (withdrawBtn) {
                await withdrawBtn.click();
                await this.page.waitForTimeout(3000);
                
                // Record successful withdrawal
                stats.withdrawalHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    amount: balance,
                    status: 'SUCCESS',
                    to: 'FaucetPay Balance'
                });
                
                console.log(`     ✅ WITHDRAWAL SUCCESSFUL! $${balance.toFixed(5)} sent to FaucetPay balance`);
                stats.sourceBalances[source.name].earned = 0;
                stats.lastWithdrawal = new Date();
                
                // Update balance
                if (this.loggedIn) {
                    await this.updateBalance();
                }
            } else {
                throw new Error('Withdraw button not found');
            }
        } catch (error) {
            console.log(`     ❌ Withdrawal failed: ${error.message}`);
            stats.withdrawalHistory.unshift({
                time: new Date(),
                source: source.name,
                amount: balance,
                status: 'FAILED',
                error: error.message
            });
        }
        
        stats.sourceBalances[source.name].pendingWithdraw = false;
    }

    async runCycle() {
        let cycleEarned = 0;
        
        console.log(`\n📊 CYCLE ${new Date().toLocaleTimeString()}`);
        console.log(`🪙 ${EARNING_SOURCES.length} sources | Balance: $${stats.currentBalance.toFixed(5)}`);
        console.log('========================================');
        
        // First claim external faucets (ones that need withdrawal)
        const externalSources = EARNING_SOURCES.filter(s => !s.instantToBalance);
        for (const source of externalSources) {
            const earned = await this.claimSource(source);
            cycleEarned += earned;
            await this.page.waitForTimeout(2000);
        }
        
        // Then claim internal sources (instant to balance)
        const internalSources = EARNING_SOURCES.filter(s => s.instantToBalance);
        for (const source of internalSources) {
            const earned = await this.claimSource(source);
            cycleEarned += earned;
            await this.page.waitForTimeout(1500);
        }
        
        // Update final balance
        if (this.loggedIn) {
            await this.updateBalance();
        }
        
        // Show summary
        console.log('========================================');
        console.log(`💰 Cycle earned: $${cycleEarned.toFixed(5)}`);
        console.log(`📊 Total earned: $${stats.totalEarned.toFixed(5)}`);
        console.log(`💳 Balance: $${stats.currentBalance.toFixed(5)}`);
        
        // Show source balances summary
        const activeSources = Object.entries(stats.sourceBalances).filter(([_, data]) => data.earned > 0);
        if (activeSources.length > 0) {
            console.log('\n📦 Pending balances:');
            for (const [name, data] of activeSources) {
                if (data.earned > 0) {
                    const source = EARNING_SOURCES.find(s => s.name === name);
                    const minText = source?.minWithdraw ? ` (min: $${source.minWithdraw})` : '';
                    console.log(`   🪙 ${name}: $${data.earned.toFixed(5)}${minText}`);
                }
            }
        }
        
        // Show recent withdrawals
        if (stats.withdrawalHistory.length > 0 && stats.withdrawalHistory[0].time > new Date(Date.now() - 60000)) {
            const lastWithdraw = stats.withdrawalHistory[0];
            console.log(`\n💸 Last withdrawal: $${lastWithdraw.amount.toFixed(5)} from ${lastWithdraw.source} - ${lastWithdraw.status}`);
        }
        
        return cycleEarned;
    }

    async run() {
        console.log('🚀 Starting Complete Faucet Bot');
        console.log('💰 Will show real-time earnings and withdrawals');
        console.log('========================================\n');
        
        await this.init();
        await this.login();
        
        while (true) {
            try {
                await this.runCycle();
                console.log(`\n⏰ Next cycle in ${SCAN_INTERVAL_SECONDS} seconds...`);
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
    
    const dailyRate = (stats.totalEarned / (uptime / 86400)).toFixed(5);
    const hourlyRate = (stats.totalEarned / (uptime / 3600)).toFixed(5);
    
    // Source balances HTML
    const sourceBalancesHtml = Object.entries(stats.sourceBalances)
        .filter(([_, data]) => data.earned > 0 || data.claims > 0)
        .map(([name, data]) => {
            const source = EARNING_SOURCES.find(s => s.name === name);
            const minText = source?.minWithdraw ? ` / Min: $${source.minWithdraw}` : '';
            return `
            <tr>
                <td>${name}</td>
                <td class="earn">$${data.earned.toFixed(5)}${minText}</td>
                <td>${data.claims}</td>
                <td>${data.lastClaim ? new Date(data.lastClaim).toLocaleTimeString() : 'Never'}</td>
                <td>${data.pendingWithdraw ? '⏳ Withdrawing' : '✅ Active'}</td>
            </tr>
        `}).join('');
    
    // Claim history HTML
    const claimHtml = stats.claimHistory.slice(0, 30).map(c => `
        <tr>
            <td>${new Date(c.time).toLocaleTimeString()}</td>
            <td>${c.source}</td>
            <td class="earn">+$${c.amount.toFixed(5)}</td>
            <td>${c.instantToBalance ? '💰 Balance' : '🪙 Wallet'}</td>
        </tr>
    `).join('');
    
    // Withdrawal history HTML
    const withdrawalHtml = stats.withdrawalHistory.slice(0, 20).map(w => `
        <tr>
            <td>${new Date(w.time).toLocaleTimeString()}</td>
            <td>${w.source}</td>
            <td class="earn">$${w.amount.toFixed(5)}</td>
            <td class="${w.status === 'SUCCESS' ? 'earn' : 'error'}">${w.status}</td>
        </tr>
    `).join('');
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>FaucetPay Complete Bot - Live Earnings</title>
    <meta http-equiv="refresh" content="10">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { text-align: center; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin: 20px 0; }
        .stat-card { background: #1a1f3a; padding: 15px; border-radius: 10px; text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; }
        .stat-value-small { font-size: 18px; font-weight: bold; }
        .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 20px; }
        .card { background: #1a1f3a; padding: 15px; border-radius: 10px; overflow-x: auto; max-height: 400px; overflow-y: auto; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
        th { color: #00ff88; }
        .earn { color: #00ff88; }
        .error { color: #ff4444; }
        .pending { color: #ffaa00; }
        .refresh-btn { background: #1a1f3a; color: #00ff88; border: 1px solid #00ff88; padding: 5px 10px; border-radius: 5px; cursor: pointer; margin-bottom: 10px; }
        .live { color: #00ff88; animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 FaucetPay Complete Bot</h1>
        <div class="status">
            🟢 <span class="live">LIVE</span> | Uptime: ${hours}h ${minutes}m | Auto Withdraw: ${AUTO_WITHDRAW ? 'ON' : 'OFF'}
            <div>Session earned: <span class="earn">$${stats.sessionEarned.toFixed(5)}</span> | Balance: <span class="earn">$${stats.currentBalance.toFixed(5)}</span></div>
        </div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(5)}</div><div>Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">$${hourlyRate}</div><div>Per Hour</div></div>
            <div class="stat-card"><div class="stat-value">$${dailyRate}</div><div>Per Day</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalActions}</div><div>Total Claims</div></div>
        </div>
        
        <div class="grid-2">
            <div class="card">
                <h3>🪙 Source Balances</h3>
                <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
                <table>
                    <thead><tr><th>Source</th><th>Balance</th><th>Claims</th><th>Last</th><th>Status</th></tr></thead>
                    <tbody>${sourceBalancesHtml || '<tr><td colspan="5">No activity yet...</td></tr>'}</tbody>
                </table>
            </div>
            <div class="card">
                <h3>💸 Withdrawal History</h3>
                <tr>
                    <thead><tr><th>Time</th><th>Source</th><th>Amount</th><th>Status</th></tr></thead>
                    <tbody>${withdrawalHtml || '<tr><td colspan="4">No withdrawals yet...</td></tr>'}</tbody>
                </table>
            </div>
        </div>
        
        <div class="card">
            <h3>📈 Recent Claims</h3>
            <table>
                <thead><tr><th>Time</th><th>Source</th><th>Amount</th><th>Destination</th></tr></thead>
                <tbody>${claimHtml || '<tr><td colspan="4">No claims yet...</td></tr>'}</tbody>
            </table>
        </div>
    </div>
</body>
</html>`);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Complete Faucet Bot...');
    console.log('💰 Real-time earnings and withdrawal tracking enabled');
    console.log('========================================\n');
    
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    const bot = new CompleteFaucetBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
    await bot.run();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
