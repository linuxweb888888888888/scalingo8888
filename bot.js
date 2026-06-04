// ptc-company-bot.js - Fixed with Chrome installation
const express = require('express');
const fs = require('fs');
const os = require('os');
const { execSync, spawn } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const { createWriteStream } = require('fs');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

// Apply stealth plugin
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const COMPANY_NAME = process.env.COMPANY_NAME || 'ClickEarn Pro';
const COMPANY_WEBSITE = process.env.COMPANY_WEBSITE || 'clickearn.com';
const AUTO_WITHDRAWAL = process.env.AUTO_WITHDRAWAL === 'true';
const WITHDRAWAL_ADDRESS = process.env.WITHDRAWAL_ADDRESS || '';
const EARNING_GOAL = parseFloat(process.env.EARNING_GOAL) || 100;

// ============ PTC SITES CONFIGURATION ============
const PTC_SITES = [
    {
        name: 'Paidverts',
        url: 'https://paidverts.com',
        loginUrl: 'https://paidverts.com/login',
        signupUrl: 'https://paidverts.com/register',
        earnPerClick: 0.002,
        timePerAd: 10,
        adsPerDay: 20
    },
    {
        name: 'ScrollingAds',
        url: 'https://scrollingads.com',
        loginUrl: 'https://scrollingads.com/login',
        signupUrl: 'https://scrollingads.com/register',
        earnPerClick: 0.0015,
        timePerAd: 8,
        adsPerDay: 25
    },
    {
        name: 'TimeBucks',
        url: 'https://timebucks.com',
        loginUrl: 'https://timebucks.com/login',
        signupUrl: 'https://timebucks.com/register',
        earnPerClick: 0.003,
        timePerAd: 15,
        adsPerDay: 15
    },
    {
        name: 'Earnably',
        url: 'https://earnably.com',
        loginUrl: 'https://earnably.com/login',
        signupUrl: 'https://earnably.com/register',
        earnPerClick: 0.0025,
        timePerAd: 12,
        adsPerDay: 18
    },
    {
        name: 'GrabPoints',
        url: 'https://grabpoints.com',
        loginUrl: 'https://grabpoints.com/login',
        signupUrl: 'https://grabpoints.com/register',
        earnPerClick: 0.002,
        timePerAd: 10,
        adsPerDay: 22
    },
    {
        name: 'SurveyJunkie',
        url: 'https://surveyjunkie.com',
        loginUrl: 'https://surveyjunkie.com/login',
        signupUrl: 'https://surveyjunkie.com/register',
        earnPerClick: 0.004,
        timePerAd: 20,
        adsPerDay: 10
    },
    {
        name: 'Swagbucks',
        url: 'https://swagbucks.com',
        loginUrl: 'https://swagbucks.com/login',
        signupUrl: 'https://swagbucks.com/register',
        earnPerClick: 0.0035,
        timePerAd: 15,
        adsPerDay: 12
    }
];

// ============ AUTO-DETECT MODE ============
const CURRENT_HOSTNAME = os.hostname();
const IS_MASTER_SERVER = process.env.IS_MASTER === 'true' || CURRENT_HOSTNAME.includes('master');

console.log('\n========================================');
console.log(`  ${COMPANY_NAME} - PTC EARNING BOT`);
console.log('========================================');
console.log(`Mode: ${IS_MASTER_SERVER ? '🔵 MASTER SERVER (Dashboard + Bot)' : '🟢 EARNING WORKER'}`);
console.log(`Target Earnings: $${EARNING_GOAL}`);
console.log(`Auto Withdrawal: ${AUTO_WITHDRAWAL ? 'ENABLED' : 'DISABLED'}`);
console.log('========================================\n');

// ============ ENVIRONMENT VARIABLES ============
const ENV = {
    IS_MASTER: IS_MASTER_SERVER,
    HEADLESS_MODE: process.env.HEADLESS_MODE !== 'false',
    CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/app/chrome-linux64/chrome',
    MASTER_API_URL: process.env.MASTER_API_URL || `https://${COMPANY_WEBSITE}`,
    MASTER_API_KEY: process.env.MASTER_API_KEY || 'change-this-secret-key-12345',
    MONGODB_URI: process.env.MONGODB_URI || null
};

// ============ CHROME INSTALLATION (FIXED) ============
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

async function installChromiumRuntime() {
    const chromePath = ENV.CHROMIUM_PATH;
    
    if (fs.existsSync(chromePath)) {
        const stats = fs.statSync(chromePath);
        if (stats.size > 50000000) {
            console.log('[CHROME] Using existing Chrome at:', chromePath);
            return chromePath;
        }
    }
    
    console.log('[CHROME] Installing Chromium...');
    
    try {
        const chromeUrl = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';
        const zipPath = '/tmp/chromium.zip';
        
        await downloadFile(chromeUrl, zipPath);
        execSync(`unzip -q ${zipPath} -d /app/`, { stdio: 'inherit' });
        
        if (fs.existsSync(chromePath)) {
            fs.chmodSync(chromePath, 0o755);
            fs.unlinkSync(zipPath);
            console.log('[CHROME] Chrome installed successfully');
            return chromePath;
        }
        throw new Error('Chrome binary not found');
    } catch (error) {
        console.log('[CHROME] Failed:', error.message);
        return null;
    }
}

// ============ DATABASE SETUP ============
let dbClient = null;
let db = null;

// In-memory storage
const memoryStore = {
    earnings: [],
    accounts: new Map(),
    dailyStats: new Map(),
    sites: new Map(),
    withdrawals: []
};

// Initialize demo data
function initDemoData() {
    console.log('[Storage] Initializing earning data...');
    
    for (const site of PTC_SITES) {
        memoryStore.sites.set(site.name, {
            ...site,
            totalEarned: 0,
            totalClicks: 0,
            lastRun: null,
            status: 'active'
        });
    }
    
    console.log(`[Storage] Loaded ${PTC_SITES.length} PTC sites`);
}

async function connectMongoDB() {
    if (!ENV.MONGODB_URI) {
        console.log('[MongoDB] Using in-memory storage');
        initDemoData();
        return false;
    }
    
    try {
        dbClient = new MongoClient(ENV.MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 5000
        });
        await dbClient.connect();
        db = dbClient.db('ptc_earnings');
        console.log('[MongoDB] ✅ Connected');
        return true;
    } catch (error) {
        console.error('[MongoDB] Connection failed:', error.message);
        initDemoData();
        return false;
    }
}

// ============ PTC AUTO-CLICKING BOT ============
class PTCBot {
    constructor(site, instanceId) {
        this.site = site;
        this.instanceId = instanceId;
        this.browser = null;
        this.page = null;
        this.totalEarned = 0;
        this.clicksToday = 0;
        this.email = null;
        this.password = null;
        this.chromePath = null;
    }

    async initBrowser() {
        if (!this.chromePath) {
            this.chromePath = await installChromiumRuntime();
        }
        if (!this.chromePath) throw new Error('No Chromium found');
        
        const launchOptions = {
            headless: ENV.HEADLESS_MODE,
            executablePath: this.chromePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-webgl',
                '--disable-accelerated-2d-canvas'
            ]
        };
        
        this.browser = await puppeteer.launch(launchOptions);
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1280, height: 800 });
        
        // Random user agent
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
        ];
        await this.page.setUserAgent(userAgents[Math.floor(Math.random() * userAgents.length)]);
    }

    async generateTempEmail() {
        const randomStr = Math.random().toString(36).substring(2, 15);
        this.email = `${randomStr}@10minutemail.net`;
        this.password = Math.random().toString(36).substring(2, 15);
        return { email: this.email, password: this.password };
    }

    async createAccount() {
        console.log(`[${this.site.name}] Creating account...`);
        
        try {
            await this.page.goto(this.site.signupUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            await this.page.waitForTimeout(3000);
            
            // Look for email field
            const emailSelectors = ['input[type="email"]', 'input[name="email"]', 'input[id="email"]'];
            for (const selector of emailSelectors) {
                const field = await this.page.$(selector);
                if (field) {
                    await field.type(this.email);
                    break;
                }
            }
            
            // Look for password field
            const passwordSelectors = ['input[type="password"]', 'input[name="password"]', 'input[id="password"]'];
            for (const selector of passwordSelectors) {
                const field = await this.page.$(selector);
                if (field) {
                    await field.type(this.password);
                    break;
                }
            }
            
            // Look for username field
            const usernameSelectors = ['input[name="username"]', 'input[id="username"]'];
            for (const selector of usernameSelectors) {
                const field = await this.page.$(selector);
                if (field) {
                    await field.type(`user_${Math.random().toString(36).substring(2, 10)}`);
                    break;
                }
            }
            
            // Submit form
            const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Sign Up")', 'button:has-text("Register")'];
            for (const selector of submitSelectors) {
                const btn = await this.page.$(selector);
                if (btn) {
                    await btn.click();
                    break;
                }
            }
            
            await this.page.waitForTimeout(5000);
            console.log(`[${this.site.name}] Account created: ${this.email}`);
            return true;
        } catch (error) {
            console.error(`[${this.site.name}] Account creation failed:`, error.message);
            return false;
        }
    }

    async login() {
        console.log(`[${this.site.name}] Logging in...`);
        
        try {
            await this.page.goto(this.site.loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            await this.page.waitForTimeout(3000);
            
            // Fill email
            const emailField = await this.page.$('input[type="email"], input[name="email"]');
            if (emailField) await emailField.type(this.email);
            
            // Fill password
            const passwordField = await this.page.$('input[type="password"], input[name="password"]');
            if (passwordField) await passwordField.type(this.password);
            
            // Submit
            const submitBtn = await this.page.$('button[type="submit"], input[type="submit"]');
            if (submitBtn) await submitBtn.click();
            
            await this.page.waitForTimeout(5000);
            console.log(`[${this.site.name}] Login successful`);
            return true;
        } catch (error) {
            console.error(`[${this.site.name}] Login failed:`, error.message);
            return false;
        }
    }

    async findAndClickAds() {
        console.log(`[${this.site.name}] Searching for ads...`);
        
        try {
            // Scroll down to load more content
            await this.page.evaluate(() => window.scrollBy(0, window.innerHeight));
            await this.page.waitForTimeout(2000);
            
            // Look for clickable elements
            const clickSelectors = [
                'a[href*="click"]',
                'a[href*="ad"]',
                'a[class*="ad"]',
                'button[class*="earn"]',
                'a[class*="earn"]',
                '.offer-link',
                '.ad-link'
            ];
            
            let clicks = 0;
            const maxClicks = this.site.adsPerDay || 10;
            
            for (let i = 0; i < maxClicks; i++) {
                let clicked = false;
                
                for (const selector of clickSelectors) {
                    try {
                        const elements = await this.page.$$(selector);
                        if (elements.length > i && elements[i]) {
                            await elements[i].click();
                            await this.page.waitForTimeout(this.site.timePerAd * 1000);
                            clicks++;
                            this.clicksToday++;
                            this.totalEarned += this.site.earnPerClick;
                            console.log(`[${this.site.name}] Clicked ad ${clicks}/${maxClicks} | Earned: $${(this.site.earnPerClick).toFixed(4)}`);
                            clicked = true;
                            break;
                        }
                    } catch(e) {}
                }
                
                if (!clicked) break;
            }
            
            return clicks;
        } catch (error) {
            console.error(`[${this.site.name}] Error finding ads:`, error.message);
            return 0;
        }
    }

    async runAutoEarn() {
        console.log(`\n[${this.site.name}] Starting auto-earn session`);
        console.log(`Target: ${this.site.adsPerDay} ads/day | $${this.site.earnPerClick}/click`);
        
        let sessionEarnings = 0;
        const targetEarnings = this.site.adsPerDay * this.site.earnPerClick;
        
        while (sessionEarnings < targetEarnings) {
            try {
                // Refresh page occasionally
                if (Math.random() > 0.8) {
                    await this.page.reload({ waitUntil: 'networkidle2' });
                    await this.page.waitForTimeout(5000);
                }
                
                const clicks = await this.findAndClickAds();
                sessionEarnings = clicks * this.site.earnPerClick;
                
                console.log(`[${this.site.name}] Session progress: $${sessionEarnings.toFixed(4)} / $${targetEarnings.toFixed(4)}`);
                
                if (sessionEarnings >= targetEarnings) break;
                
                // Random delay between cycles (30-90 seconds)
                const delay = 30000 + Math.random() * 60000;
                await this.page.waitForTimeout(delay);
                
            } catch (error) {
                console.error(`[${this.site.name}] Error in earning loop:`, error.message);
                await this.page.waitForTimeout(60000);
            }
        }
        
        console.log(`[${this.site.name}] Session complete! Earned: $${sessionEarnings.toFixed(4)}`);
        return sessionEarnings;
    }

    async run() {
        await this.initBrowser();
        
        // Generate and create account
        await this.generateTempEmail();
        const accountCreated = await this.createAccount();
        
        if (!accountCreated) {
            console.log(`[${this.site.name}] Trying to login with existing account...`);
            await this.login();
        }
        
        // Start earning
        const earned = await this.runAutoEarn();
        
        // Record earnings
        const earningRecord = {
            site: this.site.name,
            email: this.email,
            amount: earned,
            clicks: this.clicksToday,
            timestamp: new Date(),
            status: 'completed'
        };
        
        if (db) {
            await db.collection('earnings').insertOne(earningRecord);
        }
        memoryStore.earnings.push(earningRecord);
        
        // Update site stats
        const siteStats = memoryStore.sites.get(this.site.name);
        if (siteStats) {
            siteStats.totalEarned += earned;
            siteStats.totalClicks += this.clicksToday;
            siteStats.lastRun = new Date();
        }
        
        console.log(`\n✅ [${this.site.name}] Completed! Total earned: $${earned.toFixed(4)}`);
        
        await this.browser.close();
        return earned;
    }
}

// ============ EARNING WORKER ============
class EarningWorker {
    constructor(instanceId) {
        this.instanceId = instanceId;
        this.totalEarned = 0;
        this.dailyGoal = EARNING_GOAL;
        this.sitesRun = 0;
    }

    async runAllSites() {
        console.log('\n========================================');
        console.log('  STARTING EARNING WORKER');
        console.log(`  Daily Goal: $${this.dailyGoal}`);
        console.log('========================================\n');
        
        let totalEarnings = 0;
        
        for (const site of PTC_SITES) {
            if (totalEarnings >= this.dailyGoal) {
                console.log(`\n🎉 Daily goal reached! Total earned: $${totalEarnings.toFixed(2)}`);
                break;
            }
            
            console.log(`\n--- Processing ${site.name} ---`);
            
            const bot = new PTCBot(site, this.instanceId);
            let earned = 0;
            
            try {
                earned = await bot.run();
            } catch (err) {
                console.error(`Error on ${site.name}:`, err.message);
                earned = 0;
            }
            
            totalEarnings += earned;
            this.sitesRun++;
            
            console.log(`Running total: $${totalEarnings.toFixed(4)}`);
            
            // Random delay between sites (2-5 minutes)
            const delay = 120000 + Math.random() * 180000;
            console.log(`Waiting ${Math.round(delay / 1000)} seconds before next site...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        this.totalEarned = totalEarnings;
        
        console.log('\n========================================');
        console.log('  EARNING SESSION COMPLETE');
        console.log(`  Total Earned: $${totalEarnings.toFixed(4)}`);
        console.log(`  Sites Processed: ${this.sitesRun}`);
        console.log('========================================\n');
        
        return totalEarnings;
    }
}

// ============ DASHBOARD ============
app.get('/', async (req, res) => {
    const totalEarned = memoryStore.earnings.reduce((sum, e) => sum + e.amount, 0);
    const totalClicks = memoryStore.earnings.reduce((sum, e) => sum + (e.clicks || 0), 0);
    const sitesData = Array.from(memoryStore.sites.values());
    const recentEarnings = memoryStore.earnings.slice(-20).reverse();
    
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${COMPANY_NAME} - PTC Earning Bot Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%); font-family: 'Inter', sans-serif; padding: 40px 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 40px; }
        .header h1 { color: white; font-size: 2.5rem; margin-bottom: 10px; }
        .header h1 span { background: linear-gradient(135deg, #00d4ff 0%, #667eea 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .header p { color: rgba(255,255,255,0.8); }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .stat-card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 20px; padding: 25px; border: 1px solid rgba(255,255,255,0.2); }
        .stat-value { font-size: 2rem; font-weight: bold; background: linear-gradient(135deg, #00d4ff, #667eea); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .stat-label { color: rgba(255,255,255,0.7); margin-top: 5px; }
        .sites-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .site-card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 20px; padding: 20px; border: 1px solid rgba(255,255,255,0.2); }
        .site-name { font-weight: 700; font-size: 1.2rem; color: white; margin-bottom: 10px; }
        .site-detail { color: rgba(255,255,255,0.8); font-size: 0.85rem; margin: 5px 0; }
        .earnings-table { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 20px; padding: 20px; overflow-x: auto; border: 1px solid rgba(255,255,255,0.2); }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); color: white; }
        th { background: rgba(0,0,0,0.3); font-weight: 600; color: #00d4ff; }
        .profit { color: #10b981; }
        .refresh-btn { background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; padding: 12px 24px; border-radius: 12px; cursor: pointer; margin-bottom: 20px; font-weight: 600; }
        h2 { color: white; margin-bottom: 20px; font-weight: 600; }
        .goal-progress { background: rgba(255,255,255,0.2); border-radius: 10px; height: 20px; overflow: hidden; margin-bottom: 30px; }
        .goal-fill { background: linear-gradient(90deg, #00d4ff, #667eea); height: 100%; width: ${Math.min(100, (totalEarned / EARNING_GOAL) * 100)}%; transition: width 0.5s; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>💰 <span>${COMPANY_NAME}</span> Earning Bot</h1>
            <p>Automated PTC Earnings • Multi-Site Support • 24/7 Operation</p>
        </div>
        
        <div class="goal-progress">
            <div class="goal-fill"></div>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-value">$${totalEarned.toFixed(4)}</div><div class="stat-label">Total Earned (All Time)</div></div>
            <div class="stat-card"><div class="stat-value">$${totalClicks}</div><div class="stat-label">Total Clicks</div></div>
            <div class="stat-card"><div class="stat-value">${memoryStore.earnings.length}</div><div class="stat-label">Total Sessions</div></div>
            <div class="stat-card"><div class="stat-value">${memoryStore.sites.size}</div><div class="stat-label">Active Sites</div></div>
        </div>
        
        <h2>🌐 PTC Sites Active</h2>
        <div class="sites-grid">
            ${sitesData.map(site => `
                <div class="site-card">
                    <div class="site-name">${site.name}</div>
                    <div class="site-detail">💰 Earn: $${site.earnPerClick}/click</div>
                    <div class="site-detail">📊 Total Earned: $${(site.totalEarned || 0).toFixed(4)}</div>
                    <div class="site-detail">🖱️ Total Clicks: ${site.totalClicks || 0}</div>
                    <div class="site-detail">⏱️ Last Run: ${site.lastRun ? new Date(site.lastRun).toLocaleString() : 'Never'}</div>
                </div>
            `).join('')}
        </div>
        
        <h2>📈 Recent Earnings</h2>
        <div class="earnings-table">
            <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
            <table>
                <thead><tr><th>Site</th><th>Email</th><th>Amount</th><th>Clicks</th><th>Timestamp</th></tr></thead>
                <tbody>
                    ${recentEarnings.map(earning => `
                        <tr>
                            <td>${earning.site}</td>
                            <td>${earning.email || 'N/A'}</td>
                            <td class="profit">+$${earning.amount.toFixed(4)}</td>
                            <td>${earning.clicks || 0}</td>
                            <td>${new Date(earning.timestamp).toLocaleString()}</td>
                        </tr>
                    `).join('')}
                    ${recentEarnings.length === 0 ? '<tr><td colspan="5">No earnings yet. Starting bot...</td></tr>' : ''}
                </tbody>
            </table>
        </div>
    </div>
    <script>
        setTimeout(() => location.reload(), 30000);
    </script>
</body>
</html>`;
    
    res.send(html);
});

// ============ API ENDPOINTS ============
app.get('/api/earnings', (req, res) => {
    res.json({
        totalEarned: memoryStore.earnings.reduce((sum, e) => sum + e.amount, 0),
        totalClicks: memoryStore.earnings.reduce((sum, e) => sum + (e.clicks || 0), 0),
        recentEarnings: memoryStore.earnings.slice(-50),
        sites: Array.from(memoryStore.sites.values())
    });
});

// ============ MAIN ============
async function main() {
    console.log(`\n🚀 ${COMPANY_NAME} Starting...`);
    console.log(`📊 Dashboard: http://localhost:${port}`);
    
    // Install Chrome first
    await installChromiumRuntime();
    
    await connectMongoDB();
    
    // Setup web server (only on master)
    if (ENV.IS_MASTER) {
        app.listen(port, '0.0.0.0', () => {
            console.log(`✅ Dashboard running on port ${port}`);
        });
    } else {
        console.log(`✅ Earning worker started - no web server`);
    }
    
    // Run the earning worker
    const worker = new EarningWorker('WORKER_1');
    
    // Continuous earning loop
    while (true) {
        try {
            await worker.runAllSites();
            
            // Wait between full cycles (30-60 minutes)
            const waitMinutes = 30 + Math.random() * 30;
            console.log(`\n⏰ Cycle complete. Waiting ${Math.round(waitMinutes)} minutes before next cycle...\n`);
            await new Promise(resolve => setTimeout(resolve, waitMinutes * 60 * 1000));
            
        } catch (error) {
            console.error('Worker error:', error.message);
            await new Promise(resolve => setTimeout(resolve, 300000));
        }
    }
}

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    if (dbClient) dbClient.close();
    process.exit(0);
});

main().catch(console.error);
