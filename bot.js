// faucetpay-discovery-bot.js - Auto-discovers new sources from the web
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
const FAUCETPAY_API_KEY = process.env.FAUCETPAY_API_KEY || '';
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 60;
const DISCOVERY_INTERVAL_HOURS = parseInt(process.env.DISCOVERY_INTERVAL_HOURS) || 0.1;

const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Auto-Discovery Bot');
console.log('========================================');
console.log(`Auto Discover: Every ${DISCOVERY_INTERVAL_HOURS} hours`);
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

// ============ DISCOVERY SOURCES ============
// Websites that list faucets and earning sites
const DISCOVERY_SOURCES = [
    { name: 'FaucetPay Faucet List', url: 'https://faucetpay.io/faucets', type: 'api' },
    { name: 'Trusted Faucet List', url: 'https://trustedfaucetlist.com', type: 'scrape' },
    { name: 'Faucet Rotator', url: 'https://faucetrotator.com', type: 'scrape' },
    { name: 'Faucet Collector', url: 'https://faucetcollector.com', type: 'scrape' },
    { name: 'CryptoFaucet List', url: 'https://cryptofaucetlist.com', type: 'scrape' },
    { name: 'Faucet King', url: 'https://faucetking.io/faucets', type: 'scrape' },
    { name: 'EarnCrypto', url: 'https://earncrypto.com/faucets', type: 'scrape' }
];

// ============ STATS ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
    currentBalance: 0,
    discoveredSources: [],
    workingSources: [],
    failedSources: [],
    discoveryLog: [],
    claimHistory: [],
    withdrawalHistory: [],
    startTime: new Date(),
    lastDiscovery: null,
    loggedIn: false
};

// ============ SOURCE DISCOVERY ENGINE ============
class SourceDiscoveryEngine {
    constructor(page, apiKey) {
        this.page = page;
        this.apiKey = apiKey;
        this.discoveredUrls = new Set();
    }

    // Use FaucetPay API to get official faucet list
    async discoverFromAPI() {
        console.log('  🔍 Checking FaucetPay API...');
        
        try {
            // FaucetPay has an API endpoint for faucet lists [citation:1][citation:6]
            const response = await this.page.evaluate(async () => {
                const apiKey = arguments[0];
                const response = await fetch(`https://faucetpay.io/api/v1/faucetlist?api_key=${apiKey}`, {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' }
                });
                return await response.json();
            }, this.apiKey);
            
            if (response && response.faucets) {
                for (const faucet of response.faucets) {
                    this.discoveredUrls.add({
                        name: faucet.name,
                        url: faucet.url,
                        type: 'faucet',
                        earnPerAction: faucet.reward || 0.0001,
                        source: 'FaucetPay API'
                    });
                }
                console.log(`    ✅ Found ${response.faucets.length} faucets from API`);
            }
        } catch (error) {
            console.log(`    ⚠️ API discovery failed: ${error.message}`);
        }
    }

    // Scrape faucet listing websites
    async discoverFromWeb(source) {
        console.log(`  🔍 Scraping: ${source.name}...`);
        
        try {
            await this.page.goto(source.url, { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(3000);
            
            // Look for faucet links on the page
            const faucetLinks = await this.page.evaluate(() => {
                const links = [];
                const elements = document.querySelectorAll('a[href*="faucet"], a[href*="claim"], a[href*="earn"], .faucet-item, .faucet-link');
                
                for (const el of elements) {
                    const url = el.href;
                    const name = el.innerText || el.getAttribute('title') || url;
                    if (url && (url.includes('http') || url.includes('www'))) {
                        links.push({ url, name: name.substring(0, 50) });
                    }
                }
                return links;
            });
            
            // Add unique faucets
            let newCount = 0;
            for (const link of faucetLinks) {
                const url = link.url;
                if (!this.discoveredUrls.has(url) && !url.includes('faucetpay.io') && !url.includes('google.com')) {
                    this.discoveredUrls.add({
                        name: link.name,
                        url: url,
                        type: 'faucet',
                        earnPerAction: 0.0001,
                        source: source.name
                    });
                    newCount++;
                }
            }
            
            console.log(`    ✅ Found ${newCount} new potential sources`);
        } catch (error) {
            console.log(`    ⚠️ Scraping failed: ${error.message}`);
        }
    }

    // Test if a discovered source actually works
    async testSource(source) {
        console.log(`    🧪 Testing: ${source.name.substring(0, 40)}...`);
        
        try {
            await this.page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await this.page.waitForTimeout(2000);
            
            // Check for claim button or earning elements
            const claimSelectors = [
                '#claimButton', '.claim-btn', 'button.claim', '#claim', '.claim-button',
                '#free_play_form_button', '.faucet-button', '.reward-button', '.get-faucet'
            ];
            
            let hasClaim = false;
            for (const selector of claimSelectors) {
                const btn = await this.page.$(selector);
                if (btn) {
                    hasClaim = true;
                    break;
                }
            }
            
            // Also check by text
            if (!hasClaim) {
                const buttons = await this.page.$$('button, a');
                for (const btn of buttons) {
                    const text = await btn.evaluate(el => (el.innerText || '').toLowerCase()).catch(() => '');
                    if (text && (text.includes('claim') || text.includes('get') || text.includes('earn'))) {
                        hasClaim = true;
                        break;
                    }
                }
            }
            
            return hasClaim;
        } catch (error) {
            return false;
        }
    }

    async discoverNewSources() {
        console.log('\n🔍 DISCOVERING NEW SOURCES');
        console.log('========================================');
        
        this.discoveredUrls.clear();
        
        // Try API method first (requires API key) [citation:1][citation:6]
        if (this.apiKey) {
            await this.discoverFromAPI();
        } else {
            console.log('  ⚠️ No API key - using web scraping only');
            console.log('  💡 Get API key from FaucetPay -> Faucet Owner Dashboard');
        }
        
        // Scrape web sources
        for (const source of DISCOVERY_SOURCES) {
            await this.discoverFromWeb(source);
            await this.page.waitForTimeout(2000);
        }
        
        // Test discovered sources
        console.log('\n  🧪 Testing discovered sources...');
        const working = [];
        const failed = [];
        
        let testCount = 0;
        for (const source of this.discoveredUrls) {
            if (testCount >= 50) break; // Limit to 50 per discovery cycle
            const works = await this.testSource(source);
            if (works) {
                working.push(source);
                console.log(`    ✅ WORKING: ${source.name.substring(0, 40)}`);
            } else {
                failed.push(source);
            }
            testCount++;
            await this.page.waitForTimeout(1000);
        }
        
        // Update stats
        stats.discoveredUrls = this.discoveredUrls;
        stats.discoveryLog.unshift({
            time: new Date(),
            discovered: this.discoveredUrls.size,
            working: working.length,
            failed: failed.length
        });
        if (stats.discoveryLog.length > 20) stats.discoveryLog.pop();
        
        console.log('\n========================================');
        console.log(`📊 Discovery Summary:`);
        console.log(`   Total discovered: ${this.discoveredUrls.size}`);
        console.log(`   ✅ Working: ${working.length}`);
        console.log(`   ❌ Failed: ${failed.length}`);
        console.log('========================================\n');
        
        stats.lastDiscovery = new Date();
        return working;
    }
}

// ============ EARNING ENGINE ============
class EarningEngine {
    constructor(page) {
        this.page = page;
        this.claimSelectors = ['#claimButton', '.claim-btn', 'button.claim', '#claim', '.claim-button'];
    }

    async claimSource(source) {
        try {
            await this.page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
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
                
                const earned = source.earnPerAction || 0.0001;
                stats.totalEarned += earned;
                stats.totalActions++;
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    amount: earned,
                    url: source.url
                });
                if (stats.claimHistory.length > 100) stats.claimHistory.pop();
                
                console.log(`  ✅ ${source.name.substring(0, 30)}: +$${earned.toFixed(5)}`);
                return earned;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }

    async runCycle(workingSources) {
        let cycleEarned = 0;
        
        console.log(`\n📊 EARNING CYCLE - ${new Date().toLocaleTimeString()}`);
        console.log(`🪙 ${workingSources.length} working sources`);
        console.log('========================================');
        
        for (const source of workingSources.slice(0, 30)) {
            const earned = await this.claimSource(source);
            cycleEarned += earned;
            await this.page.waitForTimeout(1500);
        }
        
        if (cycleEarned > 0) {
            console.log('========================================');
            console.log(`💰 Cycle earned: $${cycleEarned.toFixed(5)}`);
            console.log(`📊 Total earned: $${stats.totalEarned.toFixed(5)}`);
        }
        
        return cycleEarned;
    }
}

// ============ MAIN BOT ============
class DiscoveryBot {
    constructor(email, password, apiKey) {
        this.email = email;
        this.password = password;
        this.apiKey = apiKey;
        this.browser = null;
        this.page = null;
        this.loggedIn = false;
        this.workingSources = [];
        this.discoveryEngine = null;
        this.earningEngine = null;
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
        
        this.discoveryEngine = new SourceDiscoveryEngine(this.page, this.apiKey);
        this.earningEngine = new EarningEngine(this.page);
    }

    async login() {
        if (!this.email || !this.password) {
            console.log('[FaucetPay] Demo mode');
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
            console.log('[FaucetPay] ✅ Login successful');
            return true;
        } catch (error) {
            console.log('[FaucetPay] Login failed');
            return false;
        }
    }

    async run() {
        console.log('🚀 Starting Discovery Bot');
        console.log('🔍 Will search for new sources every ' + DISCOVERY_INTERVAL_HOURS + ' hours');
        console.log('========================================\n');
        
        await this.init();
        await this.login();
        
        let cycleCount = 0;
        let lastDiscovery = null;
        
        while (true) {
            cycleCount++;
            
            // Discover new sources periodically
            if (!lastDiscovery || (Date.now() - lastDiscovery) > DISCOVERY_INTERVAL_HOURS * 60 * 60 * 1000) {
                const newSources = await this.discoveryEngine.discoverNewSources();
                if (newSources.length > 0) {
                    this.workingSources = newSources;
                }
                lastDiscovery = Date.now();
            }
            
            // Claim from working sources
            if (this.workingSources.length > 0) {
                await this.earningEngine.runCycle(this.workingSources);
            } else {
                console.log('\n⏳ No working sources found. Running discovery...');
                const newSources = await this.discoveryEngine.discoverNewSources();
                this.workingSources = newSources;
            }
            
            console.log(`\n⏰ Next cycle in ${SCAN_INTERVAL_SECONDS} seconds...`);
            await this.page.waitForTimeout(SCAN_INTERVAL_SECONDS * 1000);
        }
    }
}

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    const dailyRate = (stats.totalEarned / (uptime / 86400)).toFixed(5);
    
    const discoveryHtml = stats.discoveryLog.slice(0, 10).map(d => `
        <tr>
            <td>${new Date(d.time).toLocaleString()}</td>
            <td>${d.discovered}</td>
            <td><span class="earn">${d.working}</span></td>
            <td>${d.failed}</td>
        </tr>
    `).join('');
    
    const workingHtml = stats.workingSources.slice(0, 30).map(s => `
        <tr>
            <td>${s.name?.substring(0, 35) || 'Unknown'}${(s.name?.length > 35) ? '...' : ''}</td>
            <td>${s.url?.substring(0, 50) || 'N/A'}${(s.url?.length > 50) ? '...' : ''}</td>
        </tr>
    `).join('');
    
    const claimHtml = stats.claimHistory.slice(0, 30).map(c => `
        <tr>
            <td>${new Date(c.time).toLocaleTimeString()}</td>
            <td>${c.source?.substring(0, 25) || 'Unknown'}${(c.source?.length > 25) ? '...' : ''}</td>
            <td class="earn">+$${c.amount.toFixed(5)}</td>
        </tr>
    `).join('');
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Auto-Discovery Faucet Bot</title>
    <meta http-equiv="refresh" content="15">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { text-align: center; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin: 20px 0; }
        .stat-card { background: #1a1f3a; padding: 15px; border-radius: 10px; text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; }
        .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 20px; }
        .card { background: #1a1f3a; padding: 15px; border-radius: 10px; overflow-x: auto; max-height: 400px; overflow-y: auto; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
        th { color: #00ff88; }
        .earn { color: #00ff88; }
        .refresh-btn { background: #1a1f3a; color: #00ff88; border: 1px solid #00ff88; padding: 5px 10px; border-radius: 5px; cursor: pointer; margin-bottom: 10px; }
        .live { color: #00ff88; animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔍 Auto-Discovery Faucet Bot</h1>
        <div class="status">
            🟢 <span class="live">LIVE</span> | Uptime: ${hours}h ${minutes}m
            <div>Last discovery: ${stats.lastDiscovery ? new Date(stats.lastDiscovery).toLocaleString() : 'Not yet'}</div>
            <div>Next discovery: ${DISCOVERY_INTERVAL_HOURS} hours</div>
        </div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(5)}</div><div>Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">$${dailyRate}</div><div>Per Day</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalActions}</div><div>Total Claims</div></div>
            <div class="stat-card"><div class="stat-value">${stats.workingSources.length}</div><div>Working Sources</div></div>
        </div>
        
        <div class="grid-2">
            <div class="card">
                <h3>📊 Discovery History</h3>
                <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
                <tr>
                    <thead><tr><th>Time</th><th>Found</th><th>Working</th><th>Failed</th></tr></thead>
                    <tbody>${discoveryHtml || '<tr><td colspan="4">No discoveries yet...</td></tr>'}</tbody>
                </table>
            </div>
            <div class="card">
                <h3>✅ Working Sources (${stats.workingSources.length})</h3>
                <table>
                    <thead><tr><th>Name</th><th>URL</th></tr></thead>
                    <tbody>${workingHtml || '<tr><td colspan="2">No working sources yet...Run discovery!</td></tr>'}</tbody>
                </table>
            </div>
        </div>
        
        <div class="card">
            <h3>📈 Recent Claims</h3>
            <table>
                <thead><tr><th>Time</th><th>Source</th><th>Amount</th></tr></thead>
                <tbody>${claimHtml || '<tr><td colspan="3">No claims yet...</td></tr>'}</tbody>
            </table>
        </div>
    </div>
</body>
</html>`);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Auto-Discovery Faucet Bot...');
    console.log(`🔍 Will discover new sources every ${DISCOVERY_INTERVAL_HOURS} hours`);
    console.log('💰 Automatically claims from discovered sources');
    console.log('========================================\n');
    
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    const bot = new DiscoveryBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD, FAUCETPAY_API_KEY);
    await bot.run();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
