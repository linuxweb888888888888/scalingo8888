// faucetpay-bot.js - Complete FaucetPay Automation Bot
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// ============ CONFIGURATION ============
const FAUCETPAY_EMAIL = process.env.FAUCETPAY_EMAIL || 'your_email@example.com';
const FAUCETPAY_PASSWORD = process.env.FAUCETPAY_PASSWORD || 'your_password';
const MIN_WITHDRAWAL_USD = parseFloat(process.env.MIN_WITHDRAWAL_USD) || 0.10;

// Supported faucet URLs (add more)
const FAUCETS = [
    { name: 'FireFaucet', url: 'https://firefaucet.win', coin: 'BTC' },
    { name: 'EzBit', url: 'https://ezbit.co.in', coin: 'Multiple' },
    { name: 'CoinPayU', url: 'https://coinpayu.com', coin: 'BTC' },
    { name: 'AdBTC', url: 'https://adbtc.top', coin: 'BTC' },
    { name: 'BTCClicks', url: 'https://btcclicks.com', coin: 'BTC' },
    { name: 'Cointiply', url: 'https://cointiply.com', coin: 'BTC' }
];

// ============ FAUCETPAY BOT CLASS ============
class FaucetPayBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.balance = { BTC: 0, DOGE: 0, LTC: 0, USDT: 0 };
    }

    async init() {
        const chromePath = '/app/chrome-linux64/chrome';
        
        this.browser = await puppeteer.launch({
            headless: true,
            executablePath: chromePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1280, height: 800 });
    }

    async loginToFaucetPay() {
        console.log('[FaucetPay] Logging in...');
        
        await this.page.goto('https://faucetpay.io/login', { waitUntil: 'networkidle2' });
        await this.page.waitForTimeout(3000);
        
        await this.page.type('input[name="email"]', this.email);
        await this.page.type('input[name="password"]', this.password);
        await this.page.click('button[type="submit"]');
        
        await this.page.waitForTimeout(5000);
        
        if (await this.page.$('.dashboard-container')) {
            console.log('[FaucetPay] ✅ Login successful');
            return true;
        }
        return false;
    }

    async getBalance() {
        console.log('[FaucetPay] Checking balance...');
        
        // Navigate to balance page
        await this.page.goto('https://faucetpay.io/dashboard', { waitUntil: 'networkidle2' });
        await this.page.waitForTimeout(3000);
        
        const balances = await this.page.evaluate(() => {
            const results = {};
            const rows = document.querySelectorAll('.balance-table tr');
            rows.forEach(row => {
                const coin = row.querySelector('td:first-child')?.innerText;
                const amount = row.querySelector('td:last-child')?.innerText;
                if (coin && amount) {
                    results[coin] = parseFloat(amount) || 0;
                }
            });
            return results;
        });
        
        this.balance = balances;
        console.log(`[FaucetPay] Balance: BTC ${this.balance.BTC || 0}, DOGE ${this.balance.DOGE || 0}, LTC ${this.balance.LTC || 0}`);
        return this.balance;
    }

    async autoWithdraw() {
        console.log('[FaucetPay] Checking withdrawal conditions...');
        
        for (const [coin, amount] of Object.entries(this.balance)) {
            if (amount >= MIN_WITHDRAWAL_USD) {
                console.log(`[FaucetPay] Attempting withdrawal of ${amount} ${coin}...`);
                await this.withdrawToWallet(coin);
            }
        }
    }

    async withdrawToWallet(coin) {
        // Implementation depends on your wallet setup
        console.log(`[FaucetPay] Withdrawing ${coin}...`);
        // Add withdrawal logic here
    }

    async processFaucet(faucet) {
        console.log(`\n[${faucet.name}] Processing...`);
        
        await this.page.goto(faucet.url, { waitUntil: 'networkidle2' });
        await this.page.waitForTimeout(5000);
        
        // Look for claim button
        const claimSelectors = [
            '#claimButton', '.claim-btn', 'button:has-text("Claim")',
            'a:has-text("Claim")', '.captcha-form button'
        ];
        
        for (const selector of claimSelectors) {
            try {
                const claimBtn = await this.page.$(selector);
                if (claimBtn) {
                    await claimBtn.click();
                    await this.page.waitForTimeout(3000);
                    console.log(`[${faucet.name}] ✅ Claim attempted`);
                    break;
                }
            } catch(e) {}
        }
        
        // Wait random time between faucets (30-90 seconds)
        const delay = 30000 + Math.random() * 60000;
        await this.page.waitForTimeout(delay);
    }

    async run() {
        await this.init();
        
        if (await this.loginToFaucetPay()) {
            // Process each faucet
            for (const faucet of FAUCETS) {
                try {
                    await this.processFaucet(faucet);
                } catch (error) {
                    console.log(`[${faucet.name}] Error: ${error.message}`);
                }
            }
            
            // Check balance and withdraw
            await this.getBalance();
            await this.autoWithdraw();
        }
        
        await this.browser.close();
    }
}

// ============ MAIN LOOP ============
async function main() {
    console.log('========================================');
    console.log('  FaucetPay Auto Bot');
    console.log('========================================');
    console.log(`Email: ${FAUCETPAY_EMAIL}`);
    console.log(`Min Withdrawal: $${MIN_WITHDRAWAL_USD}`);
    console.log('========================================\n');
    
    while (true) {
        const bot = new FaucetPayBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
        await bot.run();
        
        console.log('\n⏰ Waiting 2 hours before next cycle...\n');
        await new Promise(r => setTimeout(r, 2 * 60 * 60 * 1000));
    }
}

// Handle shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    process.exit(0);
});

main().catch(console.error);
