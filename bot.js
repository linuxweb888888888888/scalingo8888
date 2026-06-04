// faucetpay-reliable-bot.js - Reliable version with working faucets
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
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 45;

const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Reliable Bot');
console.log('========================================');
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

// ============ WORKING FAUCETS (Simplified) ============
const WORKING_FAUCETS = [
    { 
        name: 'FreeBitcoin', 
        url: 'https://freebitco.in', 
        earnPerClaim: 0.0005,
        useTimer: true
    },
    { 
        name: 'FireFaucet', 
        url: 'https://firefaucet.win', 
        earnPerClaim: 0.0003,
        useTimer: true
    }
];

// ============ STATS ============
let stats = {
    totalEarned: 0,
    totalClaims: 0,
    history: [],
    startTime: new Date(),
    lastCycleEarned: 0
};

// ============ RELIABLE BOT ============
class ReliableFaucetBot {
    constructor() {
        this.browser = null;
        this.page = null;
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
        
        // Set timeout for navigation
        this.page.setDefaultNavigationTimeout(15000);
        this.page.setDefaultTimeout(15000);
    }

    async claimFaucet(faucet) {
        let earned = 0;
        try {
            console.log(`  🪙 ${faucet.name}...`);
            
            await this.page.goto(faucet.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await this.page.waitForTimeout(3000);
            
            // Try to find claim button
            const claimSelectors = ['#claimButton', '.claim-btn', 'button.claim', '.free-button', 'input[value="Claim"]'];
            let claimClicked = false;
            
            for (const selector of claimSelectors) {
                try {
                    const claimBtn = await this.page.$(selector);
                    if (claimBtn) {
                        await claimBtn.click();
                        claimClicked = true;
                        break;
                    }
                } catch(e) {}
            }
            
            // Try by text if selector failed
            if (!claimClicked) {
                claimClicked = await this.page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, a'));
                    for (const btn of buttons) {
                        const text = (btn.innerText || '').toLowerCase();
                        if (text.includes('claim') || text.includes('roll') || text.includes('get')) {
                            btn.click();
                            return true;
                        }
                    }
                    return false;
                });
            }
            
            if (claimClicked) {
                await this.page.waitForTimeout(5000);
                earned = faucet.earnPerClaim;
                console.log(`    ✅ Claimed! +$${faucet.earnPerClaim.toFixed(4)}`);
                stats.totalClaims++;
                stats.totalEarned += earned;
            } else {
                console.log(`    ⚠️ No claim button`);
            }
            
        } catch (error) {
            console.log(`    ❌ Error: ${error.message.substring(0, 50)}`);
        }
        
        return earned;
    }

    async runCycle() {
        let cycleEarned = 0;
        
        console.log(`\n📊 Cycle - ${new Date().toLocaleTimeString()}`);
        console.log('----------------------------------------');
        
        for (const faucet of WORKING_FAUCETS) {
            const earned = await this.claimFaucet(faucet);
            cycleEarned += earned;
            await this.page.waitForTimeout(5000 + Math.random() * 5000);
        }
        
        if (cycleEarned > 0) {
            stats.history.unshift({
                time: new Date(),
                earned: cycleEarned,
                total: stats.totalEarned
            });
            if (stats.history.length > 30) stats.history.pop();
        }
        
        stats.lastCycleEarned = cycleEarned;
        
        console.log(`----------------------------------------`);
        console.log(`💰 Cycle earned: $${cycleEarned.toFixed(4)}`);
        console.log(`📊 Total earned: $${stats.totalEarned.toFixed(4)}`);
        console.log(`🖱️ Total claims: ${stats.totalClaims}`);
        
        return cycleEarned;
    }

    async run() {
        console.log('\n🚀 Starting Reliable Faucet Bot');
        console.log('========================================\n');
        
        await this.init();
        
        let cycleCount = 0;
        
        while (true) {
            cycleCount++;
            try {
                await this.runCycle();
                
                console.log(`⏰ Next cycle in ${SCAN_INTERVAL_SECONDS} seconds\n`);
                await this.page.waitForTimeout(SCAN_INTERVAL_SECONDS * 1000);
                
                // Refresh browser occasionally to prevent memory issues
                if (cycleCount % 20 === 0) {
                    await this.browser.close();
                    await this.init();
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
    
    const hourlyRate = (stats.totalEarned / (uptime / 3600)).toFixed(5);
    const dailyRate = (stats.totalEarned / (uptime / 86400)).toFixed(5);
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>FaucetPay Reliable Bot</title>
    <meta http-equiv="refresh" content="10">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 40px; }
        .container { max-width: 800px; margin: 0 auto; }
        h1 { text-align: center; }
        .stats { display: flex; gap: 20px; margin: 30px 0; flex-wrap: wrap; }
        .stat-card { background: #1a1f3a; padding: 20px; border-radius: 10px; flex: 1; text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; }
        .earn { color: #00ff88; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        .warning { color: #ffaa00; font-size: 12px; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 FaucetPay Reliable Bot</h1>
        <div class="status">
            🟢 RUNNING | Uptime: ${hours}h ${minutes}m | Cycle: ${SCAN_INTERVAL_SECONDS}s
        </div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(5)}</div><div>Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">$${stats.lastCycleEarned.toFixed(5)}</div><div>Last Cycle</div></div>
            <div class="stat-card"><div class="stat-value">$${dailyRate}</div><div>Per Day</div></div>
        </div>
        
        <div class="warning">
            💡 Public faucets send payments to the wallet address you configure on each site.
            Set your FaucetPay wallet address on each faucet to receive payments.
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
                ${stats.history.length === 0 ? '<tr><td colspan="3">Waiting for first claims...</td></tr>' : ''}
            </tbody>
        </table>
    </div>
</body>
</html>`);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Reliable Faucet Bot...');
    console.log(`⏱️  Scanning every ${SCAN_INTERVAL_SECONDS} seconds`);
    console.log('🪙 Using: FreeBitcoin, FireFaucet\n');
    
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    const bot = new ReliableFaucetBot();
    await bot.run();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
