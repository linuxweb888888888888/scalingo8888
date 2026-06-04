// ptc-bot.js - Pure PTC Earning Bot Only
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
app.use(express.json());
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const DAILY_GOAL = parseFloat(process.env.DAILY_GOAL) || 10;
const SHOW_DASHBOARD = process.env.SHOW_DASHBOARD !== 'false';

console.log('\n========================================');
console.log('  PTC EARNING BOT');
console.log('========================================');
console.log(`Daily Goal: $${DAILY_GOAL}`);
console.log(`Dashboard: ${SHOW_DASHBOARD ? 'Enabled' : 'Disabled'}`);
console.log('========================================\n');

// ============ CHROME INSTALLATION ============
async function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = createWriteStream(destPath);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode}`));
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
    const chromePath = '/app/chrome-linux64/chrome';
    
    if (fs.existsSync(chromePath)) {
        const stats = fs.statSync(chromePath);
        if (stats.size > 50000000) {
            console.log('[Chrome] Already installed');
            return chromePath;
        }
    }
    
    console.log('[Chrome] Installing...');
    try {
        const chromeUrl = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';
        const zipPath = '/tmp/chromium.zip';
        
        await downloadFile(chromeUrl, zipPath);
        execSync(`unzip -q ${zipPath} -d /app/`, { stdio: 'inherit' });
        fs.chmodSync(chromePath, 0o755);
        fs.unlinkSync(zipPath);
        console.log('[Chrome] Installed successfully');
        return chromePath;
    } catch (error) {
        console.error('[Chrome] Failed:', error.message);
        return null;
    }
}

// ============ PTC SITES ============
const PTC_SITES = [
    { 
        name: 'CoinPayU', 
        url: 'https://coinpayu.com', 
        earnPerClick: 0.001,
        timePerAd: 5,
        adsPerDay: 50,
        selectors: ['a[href*="click"]', 'a[class*="ad"]', '.offer-link']
    },
    { 
        name: 'FaucetPay', 
        url: 'https://faucetpay.io', 
        earnPerClick: 0.002,
        timePerAd: 8,
        adsPerDay: 30,
        selectors: ['a[href*="earn"]', 'button[class*="claim"]', '.reward-link']
    },
    { 
        name: 'AdBTC', 
        url: 'https://adbtc.top', 
        earnPerClick: 0.0015,
        timePerAd: 6,
        adsPerDay: 40,
        selectors: ['a[href*="ad"]', '.ad-link', 'img[class*="banner"]']
    },
    { 
        name: 'BTCClicks', 
        url: 'https://btcclicks.com', 
        earnPerClick: 0.0012,
        timePerAd: 5,
        adsPerDay: 35,
        selectors: ['a[class*="click"]', '.surf-link', '.advertisement']
    },
    { 
        name: 'Cointiply', 
        url: 'https://cointiply.com', 
        earnPerClick: 0.003,
        timePerAd: 10,
        adsPerDay: 25,
        selectors: ['a[href*="offer"]', '.claim-button', '.earn-link']
    }
];

// ============ MEMORY STORAGE ============
let totalEarned = 0;
let totalClicks = 0;
const earningHistory = [];
const siteStats = {};

// Initialize site stats
for (const site of PTC_SITES) {
    siteStats[site.name] = { totalEarned: 0, totalClicks: 0, lastRun: null };
}

// ============ PTC BOT CLASS ============
class PTCBot {
    constructor(site) {
        this.site = site;
        this.browser = null;
        this.page = null;
        this.earned = 0;
        this.clicks = 0;
    }

    async initBrowser() {
        const chromePath = await installChrome();
        if (!chromePath) throw new Error('Chrome not available');
        
        this.browser = await puppeteer.launch({
            headless: true,
            executablePath: chromePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
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

    async findAndClickAds() {
        console.log(`  🔍 Looking for ads on ${this.site.name}...`);
        
        let clicks = 0;
        const maxClicks = this.site.adsPerDay;
        
        for (let attempt = 0; attempt < maxClicks && clicks < maxClicks; attempt++) {
            try {
                // Scroll to load more content
                await this.page.evaluate(() => window.scrollBy(0, window.innerHeight));
                await this.page.waitForTimeout(1000);
                
                let clicked = false;
                
                // Try different selectors
                for (const selector of this.site.selectors) {
                    try {
                        const elements = await this.page.$$(selector);
                        if (elements.length > 0 && elements[0]) {
                            await elements[0].click();
                            await this.page.waitForTimeout(this.site.timePerAd * 1000);
                            clicks++;
                            this.earned += this.site.earnPerClick;
                            console.log(`    ✅ Click ${clicks} | +$${this.site.earnPerClick.toFixed(4)}`);
                            clicked = true;
                            break;
                        }
                    } catch(e) {}
                }
                
                if (!clicked) {
                    // If no ads found, navigate and try again
                    await this.page.goto(this.site.url, { waitUntil: 'networkidle2' });
                    await this.page.waitForTimeout(3000);
                }
                
            } catch (error) {
                console.log(`    ⚠️ Error: ${error.message}`);
            }
        }
        
        return clicks;
    }

    async run() {
        console.log(`\n💰 Processing: ${this.site.name}`);
        console.log(`   Rate: $${this.site.earnPerClick}/click | Max: ${this.site.adsPerDay}/day`);
        
        try {
            await this.initBrowser();
            
            // Navigate to site
            await this.page.goto(this.site.url, { waitUntil: 'networkidle2', timeout: 30000 });
            await this.page.waitForTimeout(5000);
            
            // Click ads
            const clicksDone = await this.findAndClickAds();
            
            console.log(`   📊 Result: ${clicksDone} clicks | $${this.earned.toFixed(4)} earned`);
            
            // Update global stats
            totalEarned += this.earned;
            totalClicks += clicksDone;
            siteStats[this.site.name].totalEarned += this.earned;
            siteStats[this.site.name].totalClicks += clicksDone;
            siteStats[this.site.name].lastRun = new Date();
            
            // Record earning
            earningHistory.push({
                site: this.site.name,
                clicks: clicksDone,
                earned: this.earned,
                timestamp: new Date()
            });
            
            await this.browser.close();
            return this.earned;
            
        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}`);
            if (this.browser) await this.browser.close();
            return 0;
        }
    }
}

// ============ MAIN EARNING LOOP ============
async function runEarningSession() {
    console.log('\n========================================');
    console.log('  STARTING EARNING SESSION');
    console.log(`  Goal: $${DAILY_GOAL}`);
    console.log('========================================');
    
    let sessionEarnings = 0;
    
    for (const site of PTC_SITES) {
        if (sessionEarnings >= DAILY_GOAL) {
            console.log(`\n🎉 Daily goal reached! Total: $${sessionEarnings.toFixed(4)}`);
            break;
        }
        
        const bot = new PTCBot(site);
        const earned = await bot.run();
        sessionEarnings += earned;
        
        console.log(`   Running total: $${sessionEarnings.toFixed(4)}`);
        
        // Random delay between sites (30-90 seconds)
        if (site !== PTC_SITES[PTC_SITES.length - 1]) {
            const delay = 30000 + Math.random() * 60000;
            console.log(`   Waiting ${Math.round(delay / 1000)} seconds...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    
    console.log('\n========================================');
    console.log(`  SESSION COMPLETE`);
    console.log(`  Total Earned: $${sessionEarnings.toFixed(4)}`);
    console.log(`  Total Clicks: ${totalClicks}`);
    console.log('========================================\n');
    
    return sessionEarnings;
}

// ============ DASHBOARD (Optional) ============
if (SHOW_DASHBOARD) {
    app.get('/', (req, res) => {
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PTC Earning Bot Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            padding: 40px 20px;
            color: white;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 10px; }
        .subtitle { text-align: center; opacity: 0.8; margin-bottom: 40px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .stat-card { background: rgba(255,255,255,0.1); border-radius: 15px; padding: 20px; text-align: center; }
        .stat-value { font-size: 2rem; font-weight: bold; color: #00d4ff; }
        .stat-label { font-size: 0.8rem; opacity: 0.7; margin-top: 5px; }
        .sites-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .site-card { background: rgba(255,255,255,0.1); border-radius: 15px; padding: 20px; }
        .site-name { font-size: 1.2rem; font-weight: bold; margin-bottom: 10px; }
        .site-detail { font-size: 0.8rem; opacity: 0.8; margin: 5px 0; }
        .history-table { background: rgba(255,255,255,0.1); border-radius: 15px; padding: 20px; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.2); }
        th { color: #00d4ff; }
        .profit { color: #10b981; }
        .refresh-btn { background: #00d4ff; color: #000; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; margin-bottom: 20px; font-weight: bold; }
        .refresh-btn:hover { opacity: 0.9; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 PTC Earning Bot</h1>
        <div class="subtitle">Automated Paid-to-Click Earnings</div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${totalEarned.toFixed(4)}</div><div class="stat-label">Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">${totalClicks}</div><div class="stat-label">Total Clicks</div></div>
            <div class="stat-card"><div class="stat-value">${earningHistory.length}</div><div class="stat-label">Sessions</div></div>
            <div class="stat-card"><div class="stat-value">$${DAILY_GOAL}</div><div class="stat-label">Daily Goal</div></div>
        </div>
        
        <h2>🌐 Sites</h2>
        <div class="sites-grid">
            ${Object.entries(siteStats).map(([name, stats]) => `
                <div class="site-card">
                    <div class="site-name">${name}</div>
                    <div class="site-detail">💰 Earned: $${stats.totalEarned.toFixed(4)}</div>
                    <div class="site-detail">🖱️ Clicks: ${stats.totalClicks}</div>
                    <div class="site-detail">⏱️ Last: ${stats.lastRun ? new Date(stats.lastRun).toLocaleTimeString() : 'Never'}</div>
                </div>
            `).join('')}
        </div>
        
        <h2>📈 History</h2>
        <div class="history-table">
            <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
            <table>
                <thead><tr><th>Site</th><th>Clicks</th><th>Earned</th><th>Time</th></tr></thead>
                <tbody>
                    ${earningHistory.slice().reverse().slice(0, 30).map(h => `
                        <tr><td>${h.site}</td><td>${h.clicks}</td><td class="profit">+$${h.earned.toFixed(4)}</td><td>${new Date(h.timestamp).toLocaleTimeString()}</td></tr>
                    `).join('')}
                    ${earningHistory.length === 0 ? '<tr><td colspan="4">No earnings yet. Bot is running...</td></tr>' : ''}
                </tbody>
            </table>
        </div>
    </div>
    <script>setTimeout(() => location.reload(), 15000);</script>
</body>
</html>`;
        res.send(html);
    });
    
    app.get('/api/stats', (req, res) => {
        res.json({ totalEarned, totalClicks, history: earningHistory.slice(-50), sites: siteStats });
    });
}

// ============ START ============
async function main() {
    console.log('🚀 Starting PTC Earning Bot...');
    
    if (SHOW_DASHBOARD) {
        app.listen(port, '0.0.0.0', () => {
            console.log(`📊 Dashboard: http://localhost:${port}`);
        });
    }
    
    // Continuous earning loop
    while (true) {
        try {
            await runEarningSession();
            
            // Wait between full cycles (1-2 hours)
            const waitMinutes = 60 + Math.random() * 60;
            console.log(`\n⏰ Cycle complete. Waiting ${Math.round(waitMinutes)} minutes...\n`);
            await new Promise(r => setTimeout(r, waitMinutes * 60 * 1000));
            
        } catch (error) {
            console.error('Session error:', error.message);
            await new Promise(r => setTimeout(r, 300000));
        }
    }
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
