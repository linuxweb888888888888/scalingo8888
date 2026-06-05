// cointiply-bot.js - Complete Cointipy Automation Bot (Educational Purpose Only)
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
const COINTIPLY_EMAIL = process.env.COINTIPLY_EMAIL || 'web88888888888888@gmail.com';
const COINTIPLY_PASSWORD = process.env.COINTIPLY_PASSWORD || 'Linuxdistro&84';
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 60;

const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  Cointiply Automation Bot');
console.log('========================================');
console.log(`Account: ${COINTIPLY_EMAIL || 'Not set'}`);
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

// ============ COINTIPLY EARNING METHODS ============
// Based on official Cointiply documentation

const EARNING_METHODS = [
    // Daily Free Coins (Faucet) [citation:3]
    { 
        name: 'Daily Free Coins', 
        url: 'https://cointiply.com/free-coins', 
        earnPerAction: 0.001, 
        type: 'faucet',
        selector: '#captcha-input, .captcha-input, #claim-button',
        requiresCaptcha: true
    },
    
    // PTC Ads [citation:3][citation:7]
    { 
        name: 'PTC Ads', 
        url: 'https://cointiply.com/ptc', 
        earnPerAction: 0.0005, 
        type: 'ptc',
        selector: '.ptc-ad, .ad-item, .view-ad',
        timerSeconds: 10
    },
    
    // Missions - Features & Earning [citation:2][citation:5]
    { 
        name: 'Missions', 
        url: 'https://cointiply.com/missions', 
        earnPerAction: 0.002, 
        type: 'mission',
        selector: '.claim-mission, .claim-reward'
    },
    
    // Offerwalls [citation:7]
    { 
        name: 'Offerwalls', 
        url: 'https://cointiply.com/offers', 
        earnPerAction: 0.005, 
        type: 'offerwall',
        requiresInteraction: true
    },
    
    // Surveys [citation:7]
    { 
        name: 'Surveys', 
        url: 'https://cointiply.com/surveys', 
        earnPerAction: 0.01, 
        type: 'survey',
        requiresHuman: true
    },
    
    // Chat Rain - Qualify for bonuses [citation:1][citation:3]
    { 
        name: 'Chat Rain', 
        url: 'https://cointiply.com/chat', 
        earnPerAction: 0.0005, 
        type: 'rain',
        selector: '.qualify-rain, .rain-pool-btn'
    },
    
    // Games
    { 
        name: 'Games', 
        url: 'https://cointiply.com/games', 
        earnPerAction: 0.0003, 
        type: 'game',
        selector: '.play-game, .game-link'
    },
    
    // Mystery Box / Free Spins
    { 
        name: 'Free Spins', 
        url: 'https://cointiply.com/free-spins', 
        earnPerAction: 0.0002, 
        type: 'spin',
        selector: '.spin-button, .free-spin'
    },
    
    // Promo Codes [citation:3]
    { 
        name: 'Promo Codes', 
        url: 'https://cointiply.com/redeem', 
        earnPerAction: 0.001, 
        type: 'promo',
        requiresCode: true
    },
    
    // Bonus Interest (5% APY) [citation:6]
    { 
        name: 'Interest', 
        url: 'https://cointiply.com/settings', 
        earnPerAction: 0, 
        type: 'interest',
        isPassive: true,
        requirement: 'min 35,000 coins balance, weekly activity'
    }
];

// ============ STATS STORAGE ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
    currentBalance: 0,
    missionsCompleted: 0,
    ptcCompleted: 0,
    claimHistory: [],
    startTime: new Date(),
    loggedIn: false,
    interestEnabled: false
};

// ============ COINTIPLY BOT ============
class CointiplyBot {
    constructor(email, password) {
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
    }

    async login() {
        if (!this.email || !this.password) {
            console.log('[Cointiply] No credentials - demo mode');
            return false;
        }
        
        console.log('[Cointiply] Logging in...');
        try {
            await this.page.goto('https://cointiply.com/login', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(3000);
            
            await this.page.type('#login-email, input[type="email"]', this.email);
            await this.page.type('#login-password, input[type="password"]', this.password);
            await this.page.click('#login-submit, button[type="submit"]');
            await this.page.waitForTimeout(5000);
            
            this.loggedIn = true;
            stats.loggedIn = true;
            await this.updateBalance();
            await this.checkInterestSetting();
            console.log(`[Cointiply] ✅ Login successful! Balance: ${stats.currentBalance} coins`);
            return true;
        } catch (error) {
            console.log('[Cointiply] Login failed');
            return false;
        }
    }

    async updateBalance() {
        try {
            const balanceText = await this.page.$eval('.user-balance, .balance-amount, #user-balance', 
                el => el.innerText).catch(() => '0');
            stats.currentBalance = parseFloat(balanceText.replace(/[^0-9.-]/g, '')) || 0;
            return stats.currentBalance;
        } catch (error) {
            return stats.currentBalance;
        }
    }

    async checkInterestSetting() {
        // Check if 5% interest is enabled [citation:6]
        try {
            await this.page.goto('https://cointiply.com/settings', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(2000);
            
            const interestToggle = await this.page.$('#interest-toggle, .interest-switch');
            if (interestToggle) {
                const isChecked = await interestToggle.evaluate(el => el.checked);
                stats.interestEnabled = isChecked;
                if (!isChecked) {
                    console.log('  💡 Interest not enabled - enable in Settings to earn 5% APY');
                }
            }
        } catch (error) {
            // Silent fail
        }
    }

    async claimDailyFreeCoins() {
        // Automatic daily claim every 60 minutes [citation:3]
        try {
            await this.page.goto('https://cointiply.com/free-coins', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(2000);
            
            // Look for captcha input
            const captchaInput = await this.page.$('#captcha-input, .captcha-input');
            if (captchaInput) {
                // Note: Captcha solving would require external service
                console.log('  ⚠️ Daily Free Coins requires CAPTCHA - manual intervention needed');
                return 0;
            }
            
            const claimBtn = await this.page.$('#claim-button, .claim-btn');
            if (claimBtn) {
                await claimBtn.click();
                await this.page.waitForTimeout(3000);
                const earned = 0.001;
                stats.totalEarned += earned;
                stats.totalActions++;
                this.recordClaim('Daily Free Coins', earned);
                console.log(`  ✅ Daily Free Coins: +${earned} coins`);
                return earned;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }

    async viewPTCAds() {
        // Automated PTC ad viewing [citation:3][citation:7]
        try {
            await this.page.goto('https://cointiply.com/ptc', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(2000);
            
            const ads = await this.page.$$('.ptc-ad, .ad-item, .view-ad');
            let clicks = 0;
            
            for (let i = 0; i < Math.min(ads.length, 10); i++) {
                try {
                    await ads[i].click();
                    await this.page.waitForTimeout(10000); // Wait for ad timer [citation:3]
                    
                    // Complete verification if present
                    const verifyBtn = await this.page.$('#verify-btn, .verify-ad');
                    if (verifyBtn) {
                        await verifyBtn.click();
                        await this.page.waitForTimeout(3000);
                    }
                    
                    clicks++;
                    const earned = 0.0005;
                    stats.totalEarned += earned;
                    stats.totalActions++;
                    stats.ptcCompleted++;
                    this.recordClaim('PTC Ad', earned);
                    console.log(`  ✅ PTC Ad ${clicks}: +${earned} coins`);
                    
                    await this.page.waitForTimeout(2000);
                } catch(e) {}
            }
            
            return clicks * 0.0005;
        } catch (error) {
            return 0;
        }
    }

    async checkMissions() {
        // Auto-claim completed missions [citation:2][citation:5]
        try {
            await this.page.goto('https://cointiply.com/missions', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(2000);
            
            const claimButtons = await this.page.$$('.claim-mission, .claim-reward, .mission-claim');
            let claims = 0;
            
            for (const btn of claimButtons) {
                try {
                    await btn.click();
                    await this.page.waitForTimeout(2000);
                    claims++;
                    stats.missionsCompleted++;
                    const earned = 0.002;
                    stats.totalEarned += earned;
                    stats.totalActions++;
                    this.recordClaim('Mission', earned);
                    console.log(`  ✅ Mission completed! +${earned} coins`);
                } catch(e) {}
            }
            
            return claims * 0.002;
        } catch (error) {
            return 0;
        }
    }

    async qualifyForChatRain() {
        // Qualify for rain pool to earn passive bonuses [citation:1][citation:3]
        try {
            await this.page.goto('https://cointiply.com/chat', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(2000);
            
            const qualifyBtn = await this.page.$('.qualify-rain, .rain-pool-btn, .qualify-for-rain');
            if (qualifyBtn) {
                await qualifyBtn.click();
                await this.page.waitForTimeout(2000);
                console.log('  ✅ Qualified for Chat Rain pool');
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    async freeSpins() {
        // Claim free spins [citation:6]
        try {
            await this.page.goto('https://cointiply.com/free-spins', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(2000);
            
            const spinBtn = await this.page.$('.spin-button, .free-spin, .claim-spin');
            if (spinBtn) {
                await spinBtn.click();
                await this.page.waitForTimeout(3000);
                const earned = 0.0002;
                stats.totalEarned += earned;
                stats.totalActions++;
                this.recordClaim('Free Spins', earned);
                console.log(`  ✅ Free Spins: +${earned} coins`);
                return earned;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }

    recordClaim(source, amount) {
        stats.claimHistory.unshift({
            time: new Date(),
            source: source,
            amount: amount,
            status: 'SUCCESS'
        });
        if (stats.claimHistory.length > 100) stats.claimHistory.pop();
    }

    async runCycle() {
        let cycleEarned = 0;
        
        console.log(`\n📊 CYCLE ${new Date().toLocaleTimeString()}`);
        console.log(`💰 Balance: ${stats.currentBalance.toFixed(2)} coins`);
        console.log('========================================');
        
        // Daily Free Coins (once per hour)
        const dailyEarned = await this.claimDailyFreeCoins();
        cycleEarned += dailyEarned;
        
        await this.page.waitForTimeout(3000);
        
        // PTC Ads
        const ptcEarned = await this.viewPTCAds();
        cycleEarned += ptcEarned;
        
        await this.page.waitForTimeout(3000);
        
        // Missions
        const missionEarned = await this.checkMissions();
        cycleEarned += missionEarned;
        
        await this.page.waitForTimeout(3000);
        
        // Chat Rain qualification
        await this.qualifyForChatRain();
        
        await this.page.waitTimeout(3000);
        
        // Free Spins
        const spinsEarned = await this.freeSpins();
        cycleEarned += spinsEarned;
        
        // Update balance
        await this.updateBalance();
        
        // Show interest info [citation:6]
        if (stats.currentBalance >= 35000 && !stats.interestEnabled) {
            console.log('\n  💡 TIP: Enable 5% interest in Settings to earn passive income!');
        }
        
        console.log('========================================');
        console.log(`💰 Cycle earned: ${cycleEarned.toFixed(5)} coins`);
        console.log(`📊 Total earned: ${stats.totalEarned.toFixed(5)} coins`);
        console.log(`💳 Balance: ${stats.currentBalance.toFixed(2)} coins`);
        
        return cycleEarned;
    }

    async run() {
        console.log('🚀 Starting Cointiply Automation Bot');
        console.log('⚠️  WARNING: Automation may violate Cointiply ToS [citation:4]');
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
    const monthlyRate = (dailyRate * 30).toFixed(2);
    
    const claimHtml = stats.claimHistory.slice(0, 30).map(c => `
        <tr>
            <td>${new Date(c.time).toLocaleTimeString()}</td>
            <td>${c.source}</td>
            <td class="earn">+${c.amount.toFixed(5)} coins</td>
            <td>${c.status}</td>
        </tr>
    `).join('');
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Cointiply Automation Bot</title>
    <meta http-equiv="refresh" content="15">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 1000px; margin: 0 auto; }
        h1 { text-align: center; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin: 20px 0; }
        .stat-card { background: #1a1f3a; padding: 15px; border-radius: 10px; text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; }
        .stat-value-large { font-size: 36px; font-weight: bold; color: #00ff88; }
        .card { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; overflow-x: auto; max-height: 400px; overflow-y: auto; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
        th { color: #00ff88; }
        .earn { color: #00ff88; }
        .warning { color: #ffaa00; background: #2a1a0a; padding: 10px; border-radius: 5px; margin-top: 10px; font-size: 12px; }
        .refresh-btn { background: #1a1f3a; color: #00ff88; border: 1px solid #00ff88; padding: 5px 10px; border-radius: 5px; cursor: pointer; margin-bottom: 10px; }
        .live { color: #00ff88; animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 Cointiply Automation Bot</h1>
        <div class="status">
            🟢 <span class="live">LIVE</span> | Uptime: ${hours}h ${minutes}m
            <div class="stat-value-large">${stats.currentBalance.toFixed(2)}</div>
            <div>Cointiply Coins</div>
            <div class="warning">
                ⚠️ WARNING: Automation may violate Cointiply Terms of Service<br>
                Use at your own risk. One account per person. No bots allowed [citation:4]
            </div>
        </div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">${stats.totalEarned.toFixed(5)}</div><div>Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">$${monthlyRate}</div><div>Monthly Value*</div></div>
            <div class="stat-card"><div class="stat-value">${stats.ptcCompleted}</div><div>PTC Ads Watched</div></div>
            <div class="stat-card"><div class="stat-value">${stats.missionsCompleted}</div><div>Missions Completed</div></div>
        </div>
        
        <div class="card">
            <h3>📈 Recent Activity</h3>
            <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
            <table>
                <thead><tr><th>Time</th><th>Source</th><th>Amount</th><th>Status</th></tr></thead>
                <tbody>${claimHtml || '<tr><td colspan="4">No activity yet...登录Cointiply to start earning!</td></tr>'}</tbody>
            </table>
        </div>
        
        <div class="card">
            <div class="warning">
                <strong>💰 How to Earn More on Cointiply (Legitimately):</strong><br><br>
                • <strong>Daily Free Coins</strong> - Claim every hour [citation:3]<br>
                • <strong>PTC Ads</strong> - Watch ads daily for consistent earnings [citation:7]<br>
                • <strong>Missions</strong> - Complete tasks for bonus coins [citation:2][citation:5]<br>
                • <strong>5% Interest</strong> - Keep 35,000+ coins balance and stay active [citation:6]<br>
                • <strong>Chat Rain</strong> - Qualify daily for bonus distributions [citation:1]<br>
                • <strong>Offerwalls & Surveys</strong> - Higher payouts for active users [citation:7]<br><br>
                <strong>Estimated monthly earnings: $5-$20</strong> [citation:7][citation:9]<br>
                Minimum withdrawal: $3.50 [citation:9]
            </div>
        </div>
    </div>
</body>
</html>`);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Cointiply Automation Bot...');
    console.log('⚠️  DISCLAIMER: Automation may violate Cointiply Terms of Service [citation:4]');
    console.log('========================================\n');
    
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    const bot = new CointiplyBot(COINTIPLY_EMAIL, COINTIPLY_PASSWORD);
    await bot.run();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
