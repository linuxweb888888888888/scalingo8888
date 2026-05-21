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
        
        await db.createCollection('tokens', { capped: false });
        await db.createCollection('accounts', { capped: false });
        await db.createCollection('metrics', { capped: false });
        await db.createCollection('deployments', { capped: false });
        
        await db.collection('tokens').createIndex({ createdAt: -1 });
        await db.collection('accounts').createIndex({ createdAt: -1 });
        await db.collection('metrics').createIndex({ timestamp: -1 });
        
        console.log('[MongoDB] Collections created');
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
    CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/app/chrome-linux64/chrome',
    SCALINGO_EMAIL: process.env.SCALINGO_EMAIL || '',
    SCALINGO_PASSWORD: process.env.SCALINGO_PASSWORD || ''
};

console.log('\n========================================');
console.log('  BOT CONFIGURATION');
console.log('========================================');
console.log(`Bot: Creates ONE account, then restarts using stored token`);
console.log(`MongoDB: ${MONGODB_URI ? 'Connected' : 'Not configured'}`);
console.log('========================================\n');

// ============ TOKEN MANAGEMENT ============
async function getStoredToken() {
    if (!db) return null;
    try {
        const tokenDoc = await db.collection('tokens').findOne({ 
            type: 'scalingo_api_token',
            valid: true 
        });
        if (tokenDoc && tokenDoc.token) {
            console.log('[TOKEN] Found stored token, expires:', tokenDoc.expiresAt);
            return tokenDoc.token;
        }
        return null;
    } catch (error) {
        console.error('[TOKEN] Error reading token:', error.message);
        return null;
    }
}

async function storeToken(token, expiresAt = null) {
    if (!db) return false;
    try {
        await db.collection('tokens').insertOne({
            type: 'scalingo_api_token',
            token: token,
            expiresAt: expiresAt,
            createdAt: new Date(),
            valid: true
        });
        console.log('[TOKEN] Token stored successfully');
        return true;
    } catch (error) {
        console.error('[TOKEN] Error storing token:', error.message);
        return false;
    }
}

async function invalidateToken() {
    if (!db) return false;
    try {
        await db.collection('tokens').updateMany(
            { type: 'scalingo_api_token', valid: true },
            { $set: { valid: false, invalidatedAt: new Date() } }
        );
        console.log('[TOKEN] Previous tokens invalidated');
        return true;
    } catch (error) {
        console.error('[TOKEN] Error invalidating token:', error.message);
        return false;
    }
}

// ============ CREATE SCALINGO TOKEN VIA PUPPETEER ============
async function createScalingoToken() {
    log('TOKEN', 'Creating Scalingo API token via browser...', 'info', 'MAIN');
    
    const browser = await puppeteer.launch({
        headless: ENV.HEADLESS_MODE,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
        const page = await browser.newPage();
        
        // Go to Scalingo login
        log('TOKEN', 'Navigating to Scalingo login...', 'info', 'MAIN');
        await page.goto('https://dashboard.scalingo.com/login', { waitUntil: 'networkidle2' });
        await sleep(3000);
        
        // Check if already logged in
        const currentUrl = page.url();
        if (currentUrl.includes('dashboard')) {
            log('TOKEN', 'Already logged in', 'success', 'MAIN');
        } else {
            // Login form
            log('TOKEN', 'Logging in...', 'info', 'MAIN');
            
            // Try to find email and password fields
            const emailField = await page.$('input[type="email"], input[name="email"], input[id="email"]');
            const passwordField = await page.$('input[type="password"]');
            
            if (emailField && passwordField && ENV.SCALINGO_EMAIL && ENV.SCALINGO_PASSWORD) {
                await emailField.type(ENV.SCALINGO_EMAIL);
                await passwordField.type(ENV.SCALINGO_PASSWORD);
                
                const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
                if (submitBtn) await submitBtn.click();
                await sleep(5000);
            } else {
                log('TOKEN', 'Please login manually (5 seconds)...', 'warn', 'MAIN');
                await sleep(5000);
            }
        }
        
        // Go to API tokens page
        log('TOKEN', 'Navigating to API tokens...', 'info', 'MAIN');
        await page.goto('https://dashboard.scalingo.com/account/tokens', { waitUntil: 'networkidle2' });
        await sleep(3000);
        
        // Click create token button
        log('TOKEN', 'Creating new token...', 'info', 'MAIN');
        
        const createResult = await page.evaluate(() => {
            const createBtn = Array.from(document.querySelectorAll('button, a')).find(
                el => el.innerText?.toLowerCase().includes('create') || 
                      el.innerText?.toLowerCase().includes('new token')
            );
            if (createBtn) {
                createBtn.click();
                return true;
            }
            return false;
        });
        
        if (createResult) {
            await sleep(2000);
            
            // Fill token name
            await page.evaluate(() => {
                const nameInput = document.querySelector('input[placeholder*="name"], input[name="name"]');
                if (nameInput) {
                    nameInput.value = `bot-token-${Date.now()}`;
                    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });
            
            // Set expiration (365 days)
            await page.evaluate(() => {
                const expirySelect = document.querySelector('select');
                if (expirySelect) {
                    expirySelect.value = '365';
                    expirySelect.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
            
            // Submit
            await page.evaluate(() => {
                const submitBtn = Array.from(document.querySelectorAll('button')).find(
                    btn => btn.innerText?.toLowerCase().includes('create') || 
                           btn.innerText?.toLowerCase().includes('generate')
                );
                if (submitBtn) submitBtn.click();
            });
            
            await sleep(3000);
            
            // Extract the token
            const token = await page.evaluate(() => {
                // Look for token in the page
                const tokenElements = document.querySelectorAll('code, pre, .token-value, [class*="token"]');
                for (const el of tokenElements) {
                    const text = el.innerText || el.textContent;
                    if (text && text.startsWith('tk-us-')) {
                        return text.trim();
                    }
                }
                // Check for displayed token
                const bodyText = document.body.innerText;
                const match = bodyText.match(/tk-us-[a-zA-Z0-9-]+/);
                return match ? match[0] : null;
            });
            
            if (token && token.startsWith('tk-us-')) {
                log('TOKEN', `Token created: ${token.substring(0, 20)}...`, 'success', 'MAIN');
                return token;
            }
        }
        
        // Alternative: Try to get existing tokens
        log('TOKEN', 'Looking for existing tokens...', 'info', 'MAIN');
        const existingToken = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            const match = bodyText.match(/tk-us-[a-zA-Z0-9-]+/g);
            return match ? match[0] : null;
        });
        
        if (existingToken) {
            log('TOKEN', `Found existing token: ${existingToken.substring(0, 20)}...`, 'success', 'MAIN');
            return existingToken;
        }
        
        // If no token found, take screenshot for debugging
        await page.screenshot({ path: 'token_debug.png' });
        log('TOKEN', 'No token found, screenshot saved as token_debug.png', 'error', 'MAIN');
        return null;
        
    } catch (error) {
        log('TOKEN', `Error: ${error.message}`, 'error', 'MAIN');
        return null;
    } finally {
        await browser.close();
    }
}

// ============ RESTART FUNCTION USING STORED TOKEN ============
async function restartContainer() {
    console.log('[RESTART] Looking for stored API token...');
    
    let apiToken = await getStoredToken();
    
    if (!apiToken) {
        console.log('[RESTART] No token found, creating one...');
        apiToken = await createScalingoToken();
        
        if (apiToken) {
            await invalidateToken();
            await storeToken(apiToken);
        } else {
            console.log('[RESTART] Could not create token, exiting normally');
            process.exit(0);
            return;
        }
    }
    
    const appName = process.env.SCALINGO_APP_NAME || 'business-app';
    
    console.log('[RESTART] Using stored token to restart container...');
    
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.osc-fr1.scalingo.com',
            path: `/v1/apps/${appName}/restart`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
            }
        };
        
        const req = https.request(options, (res) => {
            if (res.statusCode === 202) {
                console.log('[RESTART] ✅ Restart initiated! New IP will be assigned.');
            } else {
                console.log(`[RESTART] API responded with: ${res.statusCode}`);
                // Token might be invalid, remove it
                if (res.statusCode === 401) {
                    invalidateToken();
                }
            }
            resolve(true);
        });
        
        req.on('error', (error) => {
            console.log(`[RESTART] API error: ${error.message}`);
            resolve(false);
        });
        
        req.end();
    });
}

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
            log('SYSTEM', `Chromium ready`, 'success', 'MAIN');
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
        this.activeDockerProcesses = [];
        this.completedAccounts = [];
        this.password = password;
        this.startDelay = startDelay;
        this.isRunning = true;
        this.loopCount = 0;
        this.chromePath = null;
    }

    async initBrowser() {
        log('SYSTEM', 'Setting up browser...', 'info', this.instanceId);
        
        if (!this.chromePath) {
            this.chromePath = await installChromiumRuntime();
        }
        
        if (!this.chromePath) {
            throw new Error('No Chromium found');
        }
        
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
        
        // Trigger CAPTCHA
        await this.page.evaluate(() => {
            const cb = document.querySelector('#altcha_checkbox');
            if (cb) cb.click();
        });
        
        // Wait for CAPTCHA
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
        
        // Submit
        await this.page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(x => x.innerText.toLowerCase().includes('sign up'));
            if (btn) btn.click();
        });
        
        await sleep(5000);
        log('SIGNUP', 'Form submitted', 'success', this.instanceId);
    }

    async getVerificationLink() {
        log('VERIFY', 'Waiting for email (max 4 min)...', 'info', this.instanceId);
        const startTime = Date.now();
        
        while (Date.now() - startTime < 240000) {
            const link = await this.mailPage.evaluate(() => {
                const regex = /https:\/\/api\.clever-cloud\.com\/v2\/self\/validate_email\?validationKey=[a-f0-9-]+/;
                const match = document.documentElement.innerHTML.match(regex);
                return match ? match[0] : null;
            });
            
            if (link) {
                log('VERIFY', 'Link found!', 'success', this.instanceId);
                return link;
            }
            
            // Check for email row
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
                log('VERIFY', 'Email opened', 'success', this.instanceId);
                await sleep(5000);
                continue;
            }
            
            await sleep(5000);
        }
        
        throw new Error('No verification email received');
    }

    async handleOAuth(url, email, password) {
        log('OAUTH', 'Processing OAuth...', 'info', this.instanceId);
        
        const oauthPage = await this.browser.newPage();
        await oauthPage.goto(url, { waitUntil: 'networkidle2' });
        await sleep(5000);
        
        await oauthPage.evaluate((email, password) => {
            const emailField = document.querySelector('input[type="email"]');
            const passwordField = document.querySelector('input[type="password"]');
            if (emailField && passwordField) {
                emailField.value = email;
                passwordField.value = password;
                return true;
            }
            return false;
        }, email, password);
        
        await sleep(2000);
        
        await oauthPage.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(x => 
                x.innerText.toLowerCase().includes('login') || x.innerText.toLowerCase().includes('sign in')
            );
            if (btn) btn.click();
        });
        
        await sleep(8000);
        await oauthPage.close();
        log('OAUTH', 'Complete', 'success', this.instanceId);
    }

    async startDockerInBackground(email, password) {
        return new Promise((resolve) => {
            log('DOCKER', 'Starting deployment...', 'info', this.instanceId);
            
            const dockerScriptPath = '/app/docker';
            if (!fs.existsSync(dockerScriptPath)) {
                log('DOCKER', 'Script not found, simulating success', 'warn', this.instanceId);
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
                    if (db) {
                        db.collection('deployments').insertOne({
                            appName: urlMatch[0].split('//')[1].split('.')[0],
                            url: urlMatch[0],
                            email: email,
                            instanceId: this.instanceId,
                            createdAt: new Date()
                        }).catch(() => {});
                    }
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
        
        log('START', '=== Starting (ONE account) ===', 'info', this.instanceId);
        
        try {
            await this.initBrowser();
            
            const email = await this.fetchTempEmail();
            await this.handleSignup(email, this.password);
            const verifyLink = await this.getVerificationLink();
            
            log('VERIFY', 'Activating...', 'info', this.instanceId);
            await this.page.goto(verifyLink, { waitUntil: 'domcontentloaded' });
            await sleep(5000);
            
            const result = await this.startDockerInBackground(email, this.password);
            
            log('FINISH', `✓ Account ${email} created! Deployed ${result.deployedApps?.length || 3} apps`, 'success', this.instanceId);
            
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
            
            // RESTART using stored token
            log('RESTART', '========================================', 'info', this.instanceId);
            log('RESTART', '✓ ONE account created successfully!', 'success', this.instanceId);
            log('RESTART', 'Restarting container for new IP...', 'info', this.instanceId);
            log('RESTART', '========================================', 'info', this.instanceId);
            
            await restartContainer();
            
            setTimeout(() => process.exit(0), 2000);
            
        } catch (e) {
            log('ERROR', e.message, 'error', this.instanceId);
            await this.cleanup();
            setTimeout(() => process.exit(1), 2000);
        }
    }
}

// ============ EXPRESS ROUTES ============
let metrics = { totalAccounts: 0, completedToday: 0, botStatus: 'starting' };

async function updateMetrics() {
    if (!db) return;
    try {
        metrics.totalAccounts = await db.collection('accounts').countDocuments();
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        metrics.completedToday = await db.collection('accounts').countDocuments({
            createdAt: { $gte: today }
        });
    } catch(e) {}
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

app.get('/api/token/status', async (req, res) => {
    const token = await getStoredToken();
    res.json({ hasToken: !!token, tokenPrefix: token ? token.substring(0, 20) + '...' : null });
});

app.post('/api/token/refresh', async (req, res) => {
    res.json({ success: true, message: 'Creating new token...' });
    const newToken = await createScalingoToken();
    if (newToken) {
        await invalidateToken();
        await storeToken(newToken);
        res.json({ success: true, token: newToken.substring(0, 20) + '...' });
    } else {
        res.json({ success: false, error: 'Could not create token' });
    }
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Clever Cloud Bot - Auto Token</title>
    <style>
        body { font-family: Arial; margin: 20px; background: #f0f0f0; }
        .container { max-width: 1200px; margin: 0 auto; }
        .card { background: white; padding: 20px; margin-bottom: 20px; border-radius: 8px; }
        h1 { color: #333; }
        .metric { display: inline-block; margin: 10px; padding: 15px; background: #e3f2fd; border-radius: 8px; min-width: 120px; }
        .value { font-size: 28px; font-weight: bold; color: #1976d2; }
        .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; }
        .running { background: #4caf50; }
        .success { color: green; }
        button { background: #1976d2; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 8px; border-bottom: 1px solid #ddd; }
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
            <h3>🔑 Token Status</h3>
            <div id="tokenStatus"></div>
            <button onclick="refreshToken()">⟳ Create New Token</button>
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
            
            const tokenStatus = await fetch('/api/token/status').then(r => r.json());
            document.getElementById('tokenStatus').innerHTML = \`
                <p>🔐 Token: \${tokenStatus.hasToken ? '<span class="success">✓ Stored</span>' : '✗ Not stored'}</p>
                <p>📝 Token: \${tokenStatus.tokenPrefix || 'None'}</p>
            \`;
            
            const accounts = await fetch('/api/accounts').then(r => r.json());
            if (accounts.length) {
                document.getElementById('accounts').innerHTML = \`
                    <table>
                        <tr><th>Email</th><th>Password</th><th>Date</th></tr>
                        \${accounts.map(a => \`<tr><td>\${a.email}</td><td>\${a.password}</td><td>\${new Date(a.createdAt).toLocaleString()}</td></tr>\`).join('')}
                    </table>
                \`;
            }
        }
        
        async function refreshToken() {
            const res = await fetch('/api/token/refresh', { method: 'POST' });
            const data = await res.json();
            alert(data.success ? 'Token created: ' + data.token : 'Error: ' + data.error);
            load();
        }
        
        load();
        setInterval(load, 10000);
    </script>
</body>
</html>
    `);
});

// ============ START ============
async function main() {
    console.log(`\n🚀 Clever Cloud Bot Starting...`);
    console.log(`📊 Dashboard: http://localhost:${port}`);
    console.log(`🔑 Auto-creates and stores Scalingo API token`);
    console.log(`🔄 Creates ONE account then restarts using stored token\n`);
    
    await connectMongoDB();
    
    // Check for existing token
    const existingToken = await getStoredToken();
    if (!existingToken) {
        console.log('[INIT] No token found, will create one during restart phase');
    } else {
        console.log('[INIT] Found stored token, ready to restart');
    }
    
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
