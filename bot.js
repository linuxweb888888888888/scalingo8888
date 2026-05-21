const express = require('express');
const fs = require('fs');
const os = require('os');
const { execSync, spawn } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const { createWriteStream } = require('fs');
const { MongoClient } = require('mongodb');

// Apply stealth plugin
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;

// ============ MONGODB CONNECTION ============
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';
let dbClient = null;
let db = null;

async function connectMongoDB() {
    try {
        dbClient = new MongoClient(MONGODB_URI);
        await dbClient.connect();
        db = dbClient.db('botdb');
        console.log('[MongoDB] Connected successfully');
        
        await db.createCollection('accounts', { capped: false });
        await db.createCollection('metrics', { capped: false });
        
        await db.collection('accounts').createIndex({ createdAt: -1 });
        
        return true;
    } catch (error) {
        console.error('[MongoDB] Connection failed:', error.message);
        return false;
    }
}

// ============ ENVIRONMENT VARIABLES ============
const ENV = {
    BOT_PASSWORD: process.env.BOT_PASSWORD || 'Linuxdistro&84',
    BOT_START_DELAY: parseInt(process.env.BOT_START_DELAY) || 10,
    HEADLESS_MODE: process.env.HEADLESS_MODE !== 'false',
    CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/app/chrome-linux64/chrome'
};

console.log('\n========================================');
console.log('  BOT CONFIGURATION');
console.log('========================================');
console.log(`Bot Mode: Creates ONE account, then exits (Scalingo restarts with NEW IP)`);
console.log(`MongoDB: ${MONGODB_URI ? 'Connected' : 'Not configured'}`);
console.log('========================================\n');

// ============ HELPER FUNCTIONS ============
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(step, message, type = 'info', instanceId = 'MAIN') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${instanceId}] [${step}] ${message}`);
}

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
            return chromePath;
        }
    }
    
    log('SYSTEM', 'Installing Chromium...', 'info', 'MAIN');
    
    try {
        const chromeUrl = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';
        const zipPath = '/tmp/chromium.zip';
        
        await downloadFile(chromeUrl, zipPath);
        execSync(`unzip -q ${zipPath} -d /app/`, { stdio: 'inherit' });
        
        if (fs.existsSync(chromePath)) {
            fs.chmodSync(chromePath, 0o755);
            fs.unlinkSync(zipPath);
            return chromePath;
        }
        throw new Error('Chrome binary not found');
    } catch (error) {
        log('SYSTEM', `Failed: ${error.message}`, 'error', 'MAIN');
        return null;
    }
}

// ============ BOT CLASS ============
class CleverCloudBot {
    constructor(instanceId, password, startDelay = 0) {
        this.instanceId = instanceId;
        this.browser = null;
        this.page = null;
        this.mailPage = null;
        this.realTempEmail = null;
        this.password = password;
        this.startDelay = startDelay;
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
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        };
        
        this.browser = await puppeteer.launch(launchOptions);
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1280, height: 800 });
    }

    async fetchTempEmail() {
        log('EMAIL', 'Getting temp email...', 'info', this.instanceId);
        this.mailPage = await this.browser.newPage();
        await this.mailPage.goto('https://10minutemail.net/', { waitUntil: 'domcontentloaded' });
        await sleep(5000);
        
        this.realTempEmail = await this.mailPage.evaluate(() => {
            const input = document.querySelector('#fe_text');
            if (input && input.value) return input.value;
            const span = document.querySelector('#mailAddress');
            return span ? span.textContent : null;
        });
        
        log('EMAIL', this.realTempEmail, 'success', this.instanceId);
        return this.realTempEmail;
    }

    async handleSignup(email, password) {
        log('SIGNUP', 'Creating account...', 'info', this.instanceId);
        
        await this.page.goto('https://api.clever-cloud.com/v2/sessions/signup', { waitUntil: 'networkidle2' });
        await sleep(3000);
        
        await this.page.waitForSelector('input[type="email"]');
        await this.page.type('input[type="email"]', email);
        await this.page.type('input[type="password"]', password);
        
        await this.page.evaluate(() => {
            const checkbox = document.querySelector('input[type="checkbox"]');
            if (checkbox) checkbox.click();
        });
        
        await this.page.evaluate(() => {
            const cb = document.querySelector('#altcha_checkbox');
            if (cb) cb.click();
        });
        
        log('CAPTCHA', 'Waiting for solution...', 'info', this.instanceId);
        for (let i = 0; i < 60; i++) {
            const solved = await this.page.evaluate(() => {
                const input = document.querySelector('input[name="altcha"]');
                return input && input.value && input.value.length > 20;
            });
            if (solved) {
                log('CAPTCHA', 'Solved!', 'success', this.instanceId);
                break;
            }
            await sleep(1000);
        }
        
        await this.page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(x => x.innerText.toLowerCase().includes('sign up'));
            if (btn) btn.click();
        });
        
        await sleep(5000);
        log('SIGNUP', 'Submitted', 'success', this.instanceId);
    }

    async getVerificationLink() {
        log('VERIFY', 'Waiting for email...', 'info', this.instanceId);
        const startTime = Date.now();
        
        while (Date.now() - startTime < 240000) {
            const link = await this.mailPage.evaluate(() => {
                const regex = /https:\/\/api\.clever-cloud\.com\/v2\/self\/validate_email\?validationKey=[a-f0-9-]+/;
                const match = document.documentElement.innerHTML.match(regex);
                return match ? match[0] : null;
            });
            
            if (link) return link;
            
            const clicked = await this.mailPage.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('#maillist tr'));
                const cleverRow = rows.find(r => r.innerText.toLowerCase().includes('clever'));
                if (cleverRow) {
                    const a = cleverRow.querySelector('a');
                    if (a) { a.click(); return true; }
                }
                return false;
            });
            
            if (clicked) {
                await sleep(5000);
                continue;
            }
            await sleep(5000);
        }
        throw new Error('No verification email');
    }

    async handleOAuth(url, email, password) {
        log('OAUTH', 'Processing...', 'info', this.instanceId);
        
        const oauthPage = await this.browser.newPage();
        await oauthPage.goto(url, { waitUntil: 'networkidle2' });
        await sleep(5000);
        
        await oauthPage.evaluate((email, password) => {
            const emailField = document.querySelector('input[type="email"]');
            const passwordField = document.querySelector('input[type="password"]');
            if (emailField && passwordField) {
                emailField.value = email;
                passwordField.value = password;
            }
        }, email, password);
        
        await sleep(2000);
        
        await oauthPage.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(x => 
                x.innerText.toLowerCase().includes('login')
            );
            if (btn) btn.click();
        });
        
        await sleep(8000);
        await oauthPage.close();
    }

    async startDockerInBackground(email, password) {
        return new Promise((resolve) => {
            const dockerScriptPath = '/app/docker';
            if (!fs.existsSync(dockerScriptPath)) {
                resolve({ success: true, email, deployedApps: [] });
                return;
            }
            
            const dockerProcess = spawn('bash', [dockerScriptPath], { 
                detached: true, 
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            let deployedApps = [];
            
            dockerProcess.stdout.on('data', (data) => {
                const output = data.toString();
                console.log(`[DOCKER] ${output.trim()}`);
                const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.osc-fr1\.scalingo\.io/);
                if (urlMatch && !deployedApps.includes(urlMatch[0])) {
                    deployedApps.push(urlMatch[0]);
                }
            });
            
            dockerProcess.on('close', () => {
                resolve({ success: true, email, deployedApps });
            });
            dockerProcess.unref();
        });
    }

    async cleanup() {
        if (this.browser) await this.browser.close();
    }

    async run() {
        if (this.startDelay > 0) {
            log('START', `Waiting ${this.startDelay}s...`, 'warn', this.instanceId);
            await sleep(this.startDelay * 1000);
        }
        
        log('START', '=== CREATING ONE ACCOUNT ===', 'info', this.instanceId);
        log('START', 'After account creation, bot will exit', 'info', this.instanceId);
        log('START', 'Scalingo will restart container with NEW IP', 'info', this.instanceId);
        
        try {
            await this.initBrowser();
            
            const email = await this.fetchTempEmail();
            await this.handleSignup(email, this.password);
            const verifyLink = await this.getVerificationLink();
            
            await this.page.goto(verifyLink, { waitUntil: 'domcontentloaded' });
            await sleep(5000);
            
            const result = await this.startDockerInBackground(email, this.password);
            
            if (db) {
                await db.collection('accounts').insertOne({
                    email: email,
                    password: this.password,
                    deployedApps: result.deployedApps || [],
                    createdAt: new Date(),
                    instanceId: this.instanceId
                });
            }
            
            await this.cleanup();
            
            log('SUCCESS', `✓ Account ${email} created successfully!`, 'success', this.instanceId);
            log('RESTART', '========================================', 'info', this.instanceId);
            log('RESTART', 'Bot will now exit', 'info', this.instanceId);
            log('RESTART', 'Scalingo will restart container with NEW IP address', 'info', this.instanceId);
            log('RESTART', 'Next account will have a different IP', 'info', this.instanceId);
            log('RESTART', '========================================', 'info', this.instanceId);
            
            await sleep(2000);
            process.exit(0);
            
        } catch (error) {
            log('ERROR', error.message, 'error', this.instanceId);
            await this.cleanup();
            await sleep(2000);
            process.exit(1);
        }
    }
}

// ============ EXPRESS ROUTES ============
let metrics = { totalAccounts: 0, completedToday: 0, botStatus: 'starting' };

async function updateMetrics() {
    if (!db) return;
    metrics.totalAccounts = await db.collection('accounts').countDocuments();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    metrics.completedToday = await db.collection('accounts').countDocuments({
        createdAt: { $gte: today }
    });
}

app.get('/api/metrics', async (req, res) => {
    await updateMetrics();
    res.json(metrics);
});

app.get('/api/accounts', async (req, res) => {
    if (!db) return res.json([]);
    const accounts = await db.collection('accounts').find({}).sort({ createdAt: -1 }).limit(50).toArray();
    res.json(accounts);
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <title>Clever Cloud Bot - New IP Each Account</title>
    <style>
        body { font-family: Arial; margin: 20px; background: #f0f0f0; }
        .container { max-width: 1200px; margin: 0 auto; }
        .card { background: white; padding: 20px; margin-bottom: 20px; border-radius: 8px; }
        .metric { display: inline-block; margin: 10px; padding: 15px; background: #e3f2fd; border-radius: 8px; }
        .value { font-size: 28px; font-weight: bold; color: #1976d2; }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 8px; border-bottom: 1px solid #ddd; }
        .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; }
        .running { background: #4caf50; }
        .info { color: #2196f3; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 Clever Cloud Bot</h1>
        <div class="card">
            <h3>📊 Stats</h3>
            <div id="stats"></div>
        </div>
        <div class="card">
            <h3>🌐 Mode</h3>
            <div id="mode"></div>
        </div>
        <div class="card">
            <h3>📋 Recent Accounts</h3>
            <div id="accounts"></div>
        </div>
    </div>
    <script>
        async function load() {
            const stats = await fetch('/api/metrics').then(r => r.json());
            document.getElementById('stats').innerHTML = \`
                <div class="metric"><div class="value">\${stats.totalAccounts || 0}</div>Total Accounts</div>
                <div class="metric"><div class="value">\${stats.completedToday || 0}</div>Today</div>
                <div class="metric"><div class="value">\${stats.botStatus}</div>Status</div>
            \`;
            
            document.getElementById('mode').innerHTML = \`
                <p class="info">🔄 Mode: <strong>One Account Then Restart</strong></p>
                <p class="info">🌐 Each restart gives a <strong>NEW PUBLIC IP</strong> address</p>
                <p class="info">✅ Bot creates 1 account, exits, Scalingo restarts with new IP</p>
            \`;
            
            const accounts = await fetch('/api/accounts').then(r => r.json());
            if (accounts.length) {
                document.getElementById('accounts').innerHTML = \`
                    <table>
                        <tr><th>Email</th><th>Password</th><th>Date</th></tr>
                        \${accounts.map(a => \`<tr><td>\${a.email}</td><td>\${a.password}</td><td>\${new Date(a.createdAt).toLocaleString()}</td></tr>\`).join('')}
                    20点
                \`;
            }
        }
        load();
        setInterval(load, 10000);
    </script>
</body>
</html>`);
});

// ============ START ============
async function main() {
    console.log(`\n🚀 Clever Cloud Bot Starting...`);
    console.log(`📊 Dashboard: http://localhost:${port}`);
    console.log(`🔄 Mode: Create ONE account, then restart for NEW IP`);
    console.log(`\n`);
    
    await connectMongoDB();
    
    setTimeout(() => {
        const bot = new CleverCloudBot('INSTANCE_1', ENV.BOT_PASSWORD, ENV.BOT_START_DELAY);
        metrics.botStatus = 'running';
        bot.run().catch(console.error);
    }, 5000);
    
    app.listen(port, '0.0.0.0', () => console.log(`✅ Dashboard on port ${port}`));
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
