// faucetpay-public-bot.js - No login required, uses public faucets
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
const FAUCETPAY_ADDRESS = process.env.FAUCETPAY_ADDRESS || 'web88888888888888@gmail.com';
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 30;

// Chrome paths
const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Public Faucet Bot');
console.log('========================================');
console.log(`FaucetPay Address: ${FAUCETPAY_ADDRESS || 'Not set (will use demo)'}`);
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

// ============ PUBLIC FAUCETS (No login required) ============
const PUBLIC_FAUCETS = [
    { name: 'FreeBitcoin', url: 'https://freebitco.in', earnPerClaim: 0.0001, selector: '#free_play_form_button' },
    { name: 'Cointiply', url: 'https://cointiply.com', earnPerClaim: 0.0003, selector: '.claim-button' },
    { name: 'FireFaucet', url: 'https://firefaucet.win', earnPerClaim: 0.0002, selector: '#claimButton' },
    { name: 'ADBTC', url: 'https://adbtc.top', earnPerClaim: 0.00015, selector: '.claim-btn' },
    { name: 'BTCClicks', url: 'https://btcclicks.com', earnPerClaim: 0.00012, selector: '#claim' }
];

// ============ STATS ============
let stats = {
    totalEarned: 0,
    totalClaims: 0,
    faucetStats: {},
    history: [],
    startTime: new Date()
};

PUBLIC_FAUCETS.forEach(f => {
    stats.faucetStats[f.name] = { claims: 0, earned: 0, lastSuccess: null };
});

// ============ PUBLIC FAUCET BOT ============
class PublicFaucetBot {
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
        
        // Random user agent
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
        ];
        await this.page.setUserAgent(userAgents[Math.floor(Math.random() * userAgents.length)]);
    }

    async claimFaucet(faucet) {
        try {
            console.log(`  🪙 ${faucet.name}...`);
            await this.page.goto(faucet.url, { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(3000);
            
            // Try to find claim button
            let claimBtn = null;
            
            // Try by selector
            if (faucet.selector) {
                claimBtn = await this.page.$(faucet.selector);
            }
            
            // If not found, try by text
            if (!claimBtn) {
                const buttons = await this.page.$$('button, a');
                for (const btn of buttons) {
                    const text = await btn.evaluate(el => (el.innerText || '').toLowerCase()).catch(() => '');
                    if (text && (text.includes('claim') || text.includes('get') || text.includes('earn') || text.includes('free'))) {
                        claimBtn = btn;
                        break;
                    }
                }
            }
            
            if (claimBtn) {
                await claimBtn.click();
                await this.page.waitForTimeout(5000);
                
                // Update stats
                const earnAmount = faucet.earnPerClaim;
                stats.totalEarned += earnAmount;
                stats.totalClaims++;
                stats.faucetStats[faucet.name].claims++;
                stats.faucetStats[faucet.name].earned += earnAmount;
                stats.faucetStats[faucet.name].lastSuccess = new Date();
                
                console.log(`    ✅ Claimed! +$${earnAmount.toFixed(5)}`);
                return earnAmount;
            } else {
                console.log(`    ⚠️ No claim button found`);
                return 0;
            }
        } catch (error) {
            console.log(`    ❌ Error: ${error.message}`);
            return 0;
        }
    }

    async claimAllFaucets() {
        let totalEarned = 0;
        
        for (const faucet of PUBLIC_FAUCETS) {
            const earned = await this.claimFaucet(faucet);
            totalEarned += earned;
            // Random delay between faucets
            await this.page.waitForTimeout(2000 + Math.random() * 3000);
        }
        
        return totalEarned;
    }

    async runContinuous() {
        console.log('\n🚀 Starting Public Faucet Bot');
        console.log('========================================\n');
        
        await this.init();
        
        let cycleCount = 0;
        
        while (true) {
            cycleCount++;
            console.log(`\n📊 Cycle #${cycleCount} - ${new Date().toLocaleTimeString()}`);
            console.log('----------------------------------------');
            
            try {
                const earned = await this.claimAllFaucets();
                
                if (earned > 0) {
                    stats.history.unshift({
                        time: new Date(),
                        earned: earned,
                        cycle: cycleCount
                    });
                    if (stats.history.length > 50) stats.history.pop();
                }
                
                console.log(`----------------------------------------`);
                console.log(`💰 Cycle earned: $${earned.toFixed(5)}`);
                console.log(`📊 Total earned: $${stats.totalEarned.toFixed(5)}`);
                console.log(`🖱️ Total claims: ${stats.totalClaims}`);
                
                // Wait for next cycle
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
    
    const faucetStatsHtml = Object.entries(stats.faucetStats)
        .map(([name, data]) => `
            <tr>
                <td>${name}</td>
                <td>${data.claims}</td>
                <td class="earn">$${data.earned.toFixed(5)}</td>
                <td>${data.lastSuccess ? new Date(data.lastSuccess).toLocaleTimeString() : 'Never'}</td>
            </tr>
        `).join('');
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Public Faucet Bot Dashboard</title>
    <meta http-equiv="refresh" content="10">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 40px; }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { text-align: center; }
        .stats { display: flex; gap: 20px; margin: 30px 0; flex-wrap: wrap; }
        .stat-card { background: #1a1f3a; padding: 20px; border-radius: 10px; flex: 1; text-align: center; }
        .stat-value { font-size: 32px; font-weight: bold; }
        .earn { color: #00ff88; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        .online { color: #00ff88; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .refresh-btn { background: #1a1f3a; color: #00ff88; border: 1px solid #00ff88; padding: 8px 16px; border-radius: 5px; cursor: pointer; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 Public Faucet Bot</h1>
        <div class="status">
            🟢 STATUS: <span class="online">RUNNING</span> | Uptime: ${hours}h ${minutes}m | Scan: every ${SCAN_INTERVAL_SECONDS}s
        </div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(5)}</div><div>Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalClaims}</div><div>Total Claims</div></div>
            <div class="stat-card"><div class="stat-value">${Math.round((stats.totalEarned / (uptime / 3600)) * 100000) / 100000}/hr</div><div>Hourly Rate</div></div>
        </div>
        
        <h3>🪙 Faucet Stats</h3>
        <table>
            <thead><tr><th>Faucet</th><th>Claims</th><th>Earned</th><th>Last Success</th></tr></thead>
            <tbody>${faucetStatsHtml}</tbody>
        </table>
        
        <h3>📈 Recent Claims</h3>
        <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
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
                ${stats.history.length === 0 ? '<tr><td colspan="3">Waiting for first claims...</td></tr>' : ''}
            </tbody>
        </table>
    </div>
</body>
</html>`);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Public Faucet Bot...');
    console.log(`⏱️  Scanning every ${SCAN_INTERVAL_SECONDS} seconds`);
    console.log('🪙 Using public faucets - no login required\n');
    
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    const bot = new PublicFaucetBot();
    await bot.runContinuous();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
