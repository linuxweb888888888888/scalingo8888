// cointiply-bot.js - Safe Cointiply automation bot
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');

puppeteer.use(StealthPlugin());

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
// NEVER hardcode credentials - use environment variables!
const COINTIPLY_EMAIL = process.env.COINTIPLY_EMAIL | "web88888888888888@gmail.com";
const COINTIPLY_PASSWORD = process.env.COINTIPLY_PASSWORD | "Linuxdistro&84";
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';

if (!COINTIPLY_EMAIL || !COINTIPLY_PASSWORD) {
    console.error('❌ Please set COINTIPLY_EMAIL and COINTIPLY_PASSWORD environment variables');
    console.log('Example:');
    console.log('  export COINTIPLY_EMAIL="your@email.com"');
    console.log('  export COINTIPLY_PASSWORD="your_password"');
    process.exit(1);
}

console.log('\n========================================');
console.log('  Cointiply Auto-Claim Bot');
console.log('========================================');
console.log(`Email: ${COINTIPLY_EMAIL.replace(/(.{3}).*(@.*)/, '$1***$2')}`);
console.log(`Headless: ${HEADLESS_MODE}`);
console.log('========================================\n');

// Stats storage
let stats = {
    totalEarned: 0,
    totalClaims: 0,
    lastClaim: null,
    currentBalance: 0,
    startTime: new Date()
};

class CointiplyBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
    }

    async init() {
        this.browser = await puppeteer.launch({
            headless: HEADLESS_MODE,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1280, height: 800 });
    }

    async solveCaptcha() {
        // Cointiply uses Altcha (not traditional captcha)
        console.log('  🤖 Waiting for Altcha automation...');
        console.log('  ⚠️ Cointiply requires manual interaction for first claim');
        
        // Check if altcha is present
        const hasAltcha = await this.page.$('div[class*="altcha"]').catch(() => null);
        if (hasAltcha) {
            console.log('  🔐 Altcha detected - bot cannot bypass');
            console.log('  💡 You may need to claim manually in the browser window');
            return false;
        }
        return true;
    }

    async login() {
        console.log('[Cointiply] Logging in...');
        
        try {
            await this.page.goto('https://cointiply.com/login', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(3000);
            
            // Fill email
            await this.page.type('#email, input[name="email"], input[type="email"]', this.email);
            await this.page.waitForTimeout(500);
            
            // Fill password
            await this.page.type('#password, input[name="password"]', this.password);
            await this.page.waitForTimeout(500);
            
            // Click login button
            await this.page.click('button[type="submit"], .login-btn, #login-btn');
            await this.page.waitForTimeout(5000);
            
            // Check if login successful
            const loggedIn = await this.page.evaluate(() => {
                return window.location.href.includes('/dashboard') || 
                       window.location.href.includes('/home') ||
                       document.querySelector('.user-balance');
            }).catch(() => false);
            
            if (loggedIn) {
                console.log('[Cointiply] ✅ Login successful!');
                await this.updateBalance();
                return true;
            } else {
                console.log('[Cointiply] ❌ Login failed - check credentials');
                return false;
            }
        } catch (error) {
            console.error(`[Cointiply] Login error: ${error.message}`);
            return false;
        }
    }

    async updateBalance() {
        try {
            const balance = await this.page.$eval('.balance, .user-balance, .coins', el => el.innerText).catch(() => '0');
            const numBalance = parseFloat(balance.replace(/[^0-9.-]/g, '')) || 0;
            stats.currentBalance = numBalance;
            console.log(`💰 Balance: ${numBalance} coins`);
            return numBalance;
        } catch (error) {
            return stats.currentBalance;
        }
    }

    async claimFaucet() {
        console.log('\n[Claim] Attempting to claim hourly faucet...');
        
        try {
            // Go to faucet page
            await this.page.goto('https://cointiply.com/faucet', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(3000);
            
            // Look for the roll/claim button
            const claimButton = await this.page.$('#roll-button, .claim-btn, .faucet-claim, button[onclick*="roll"]');
            
            if (claimButton) {
                // Check if button is enabled
                const isDisabled = await claimButton.evaluate(el => el.disabled || el.classList.contains('disabled')).catch(() => false);
                
                if (isDisabled) {
                    console.log('  ⏰ Faucet on cooldown - come back in an hour');
                    return 0;
                }
                
                await claimButton.click();
                await this.page.waitForTimeout(3000);
                
                // Check if captcha appears
                const captchaSolved = await this.solveCaptcha();
                if (!captchaSolved) {
                    console.log('  ⚠️ Manual captcha solving required in browser');
                    await this.page.waitForTimeout(15000); // Wait for manual solve
                }
                
                // Get result
                const result = await this.page.$eval('.result, .reward, .message', el => el.innerText).catch(() => '');
                const rewardMatch = result.match(/(\d+(?:\.\d+)?)/);
                const earned = rewardMatch ? parseFloat(rewardMatch[1]) : 0;
                
                if (earned > 0) {
                    stats.totalEarned += earned;
                    stats.totalClaims++;
                    stats.lastClaim = new Date();
                    console.log(`  ✅ Claimed! +${earned} coins`);
                    await this.updateBalance();
                    return earned;
                } else {
                    console.log(`  ℹ️ Result: ${result || 'No reward this time'}`);
                    return 0;
                }
            } else {
                console.log('  ❌ Claim button not found');
                return 0;
            }
        } catch (error) {
            console.error(`  ❌ Claim error: ${error.message}`);
            return 0;
        }
    }

    async run() {
        await this.init();
        
        const loggedIn = await this.login();
        if (!loggedIn) {
            console.log('\n❌ Cannot continue - login failed');
            console.log('Please check your credentials and try again');
            return;
        }
        
        console.log('\n🔄 Starting claim loop...');
        console.log('Cointiply faucet can be claimed every hour\n');
        
        while (true) {
            try {
                await this.claimFaucet();
                
                // Wait 1 hour between claims
                console.log('\n⏰ Waiting 60 minutes until next claim...');
                await this.page.waitForTimeout(60 * 60 * 1000);
            } catch (error) {
                console.error(`Loop error: ${error.message}`);
                await this.page.waitForTimeout(60000);
            }
        }
    }
}

// Dashboard
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Cointiply Bot Dashboard</title>
    <meta http-equiv="refresh" content="30">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 800px; margin: 0 auto; }
        .card { background: #1a1f3a; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
        .stat { font-size: 36px; font-weight: bold; }
        .label { color: #888; margin-top: 10px; }
        .live { animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <h1>💰 Cointiply Bot</h1>
            <div class="live">🟢 RUNNING</div>
            <div class="stat">${stats.totalEarned} coins</div>
            <div class="label">Total Earned</div>
            <div class="stat">${stats.totalClaims}</div>
            <div class="label">Total Claims</div>
            <div class="stat">${stats.currentBalance} coins</div>
            <div class="label">Current Balance</div>
            <div class="label">Uptime: ${hours} hours</div>
            <div class="label">Last claim: ${stats.lastClaim ? new Date(stats.lastClaim).toLocaleTimeString() : 'Never'}</div>
        </div>
    </div>
</body>
</html>
    `);
});

// Main
async function main() {
    app.listen(port, () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    const bot = new CointiplyBot(COINTIPLY_EMAIL, COINTIPLY_PASSWORD);
    await bot.run();
}

main().catch(console.error);
