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
    CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/app/chrome-linux64/chrome',
    CLEVER_TOKEN: process.env.CLEVER_TOKEN || '',
    SCALINGO_APP_NAME: process.env.SCALINGO_APP_NAME || ''
};

console.log('\n========================================');
console.log('  BOT CONFIGURATION');
console.log('========================================');
console.log(`Bot Mode: Creates ONE account, then CLI RESTART for NEW IP`);
console.log(`MongoDB: ${MONGODB_URI ? 'Connected' : 'Not configured'}`);
console.log(`Clever Token: ${ENV.CLEVER_TOKEN ? '✓ Configured' : '✗ Not configured'}`);
console.log(`Scalingo App: ${ENV.SCALINGO_APP_NAME || 'Not set'}`);
console.log('========================================\n');

// ============ STATE VARIABLES ============
let botStatus = {
    state: 'starting',
    accountCreated: false,
    accountEmail: null,
    startTime: new Date(),
    completionTime: null,
    restartCount: 0
};

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

// ============ CLI RESTART FUNCTION ============
async function restartWithCLI() {
    const appName = ENV.SCALINGO_APP_NAME;
    
    if (!appName) {
        log('RESTART', 'SCALINGO_APP_NAME not set, using exit restart', 'warn', 'MAIN');
        return false;
    }
    
    log('RESTART', `Restarting app via CLI: ${appName}`, 'info', 'MAIN');
    
    return new Promise((resolve) => {
        // First, login to Scalingo (if needed)
        const loginCmd = `scalingo login --api-token "${process.env.SCALINGO_API_TOKEN}" 2>/dev/null || scalingo login`;
        
        // Then restart the app
        const restartCmd = `scalingo --app ${appName} restart`;
        
        // Combine commands
        const fullCmd = `${loginCmd} && ${restartCmd}`;
        
        const child = spawn('bash', ['-c', fullCmd], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        child.stdout.on('data', (data) => {
            console.log(`[CLI] ${data.toString().trim()}`);
        });
        
        child.stderr.on('data', (data) => {
            console.log(`[CLI ERR] ${data.toString().trim()}`);
        });
        
        child.on('close', (code) => {
            if (code === 0) {
                log('RESTART', '✅ CLI restart initiated successfully!', 'success', 'MAIN');
                resolve(true);
            } else {
                log('RESTART', `CLI restart returned code ${code}`, 'error', 'MAIN');
                resolve(false);
            }
        });
        
        child.unref();
    });
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
        this.oauthHandled = false;
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
        
        if (!this.realTempEmail) {
            throw new Error('Could not extract email');
        }
        
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
        let captchaSolved = false;
        for (let i = 0; i < 60; i++) {
            const solved = await this.page.evaluate(() => {
                const input = document.querySelector('input[name="altcha"]');
                return input && input.value && input.value.length > 20;
            });
            if (solved) {
                log('CAPTCHA', 'Solved!', 'success', this.instanceId);
                captchaSolved = true;
                break;
            }
            await sleep(1000);
        }
        
        if (!captchaSolved) {
            log('CAPTCHA', 'Warning: CAPTCHA may not have solved', 'warn', this.instanceId);
        }
        
        await this.page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(x => x.innerText.toLowerCase().includes('sign up'));
            if (btn) btn.click();
        });
        
        await sleep(8000);
        log('SIGNUP', 'Form submitted', 'success', this.instanceId);
    }

    async getVerificationLink() {
        log('VERIFY', 'Waiting for verification email (max 5 min)...', 'info', this.instanceId);
        const startTime = Date.now();
        let emailFound = false;
        
        while (Date.now() - startTime < 300000) {
            let link = await this.mailPage.evaluate(() => {
                const regex = /https:\/\/api\.clever-cloud\.com\/v2\/self\/validate_email\?validationKey=[a-f0-9-]+/;
                const match = document.documentElement.innerHTML.match(regex);
                return match ? match[0] : null;
            });
            
            if (link) {
                log('VERIFY', 'Verification link found!', 'success', this.instanceId);
                return link;
            }
            
            if (!emailFound) {
                const clicked = await this.mailPage.evaluate(() => {
                    const rows = Array.from(document.querySelectorAll('#maillist tr'));
                    for (const row of rows) {
                        const text = (row.innerText || '').toLowerCase();
                        if (text.includes('clever cloud') || text.includes('clever-cloud')) {
                            const a = row.querySelector('a');
                            if (a) {
                                a.click();
                                return true;
                            }
                        }
                    }
                    return false;
                });
                
                if (clicked) {
                    emailFound = true;
                    log('VERIFY', 'Email found, loading content...', 'success', this.instanceId);
                    await sleep(8000);
                    continue;
                }
            }
            
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            process.stdout.write(`\r  Waiting for email... ${elapsed}s / 300s`);
            await sleep(5000);
        }
        
        console.log();
        throw new Error('No verification email received after 5 minutes');
    }

    async handleOAuth(url, email, password) {
        log('OAUTH', '========================================', 'info', this.instanceId);
        log('OAUTH', 'Opening OAuth URL for auto-login...', 'info', this.instanceId);
        
        try {
            const oauthPage = await this.browser.newPage();
            await oauthPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            log('OAUTH', 'OAuth page loaded', 'success', this.instanceId);
            await sleep(3000);
            
            const credentialsFilled = await oauthPage.evaluate((email, password) => {
                const emailField = document.querySelector('input[type="email"], input[name="email"], input[id="email"]');
                const passwordField = document.querySelector('input[type="password"], input[name="password"], input[id="password"]');
                
                if (emailField && passwordField) {
                    emailField.value = email;
                    passwordField.value = password;
                    emailField.dispatchEvent(new Event('input', { bubbles: true }));
                    passwordField.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                }
                return false;
            }, email, password);
            
            if (credentialsFilled) {
                log('OAUTH', 'Credentials filled successfully', 'success', this.instanceId);
                await sleep(2000);
                
                const loginClicked = await oauthPage.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                    const loginButton = buttons.find(btn => {
                        const text = (btn.innerText || btn.value || '').toLowerCase();
                        return text.includes('login') || text.includes('sign in') || text.includes('log in');
                    });
                    if (loginButton) {
                        loginButton.click();
                        return true;
                    }
                    const form = document.querySelector('form');
                    if (form) {
                        form.submit();
                        return true;
                    }
                    return false;
                });
                
                if (loginClicked) {
                    log('OAUTH', 'Login button clicked!', 'success', this.instanceId);
                }
            }
            
            await sleep(8000);
            await oauthPage.close();
            log('OAUTH', 'OAuth flow completed', 'success', this.instanceId);
            log('OAUTH', '========================================', 'info', this.instanceId);
            return true;
        } catch (error) {
            log('OAUTH', `OAuth error: ${error.message}`, 'error', this.instanceId);
            return false;
        }
    }

    async startDockerInBackground(email, password) {
        return new Promise((resolve, reject) => {
            const dockerId = `${this.instanceId}_${Date.now()}`;
            const logFile = `docker_${this.instanceId}_${dockerId}.log`;
            
            log('DOCKER', 'Starting Docker deployment...', 'info', this.instanceId);
            
            const dockerScriptPath = '/app/docker';
            if (!fs.existsSync(dockerScriptPath)) {
                log('DOCKER', 'Docker script not found', 'warn', this.instanceId);
                resolve({ success: true, email, deployedApps: [] });
                return;
            }
            
            const dockerProcess = spawn('bash', [dockerScriptPath], { 
                detached: true, 
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, CLEVER_TOKEN: ENV.CLEVER_TOKEN }
            });
            
            let deployedApps = [];
            let oauthUrlDetected = false;
            
            const extractOAuthUrl = (output) => {
                const match = output.match(/https:\/\/console\.clever-cloud\.com\/cli-oauth\?[^\s]+/);
                return match ? match[0] : null;
            };
            
            dockerProcess.stdout.on('data', async (data) => {
                const output = data.toString();
                console.log(`[DOCKER] ${output.trim()}`);
                
                if (!oauthUrlDetected && !this.oauthHandled) {
                    const oauthUrl = extractOAuthUrl(output);
                    if (oauthUrl) {
                        oauthUrlDetected = true;
                        this.oauthHandled = true;
                        log('OAUTH', 'Detected OAuth URL, handling automatically...', 'success', this.instanceId);
                        await this.handleOAuth(oauthUrl, email, password);
                    }
                }
                
                const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.osc-fr1\.scalingo\.io/);
                if (urlMatch && !deployedApps.includes(urlMatch[0])) {
                    deployedApps.push(urlMatch[0]);
                    log('DOCKER', `App deployed: ${urlMatch[0]}`, 'success', this.instanceId);
                }
                
                if (output.includes('All 3 apps deployed')) {
                    log('DOCKER', 'Deployment completed successfully!', 'success', this.instanceId);
                    resolve({ success: true, email, deployedApps });
                }
            });
            
            dockerProcess.stderr.on('data', (data) => {
                const err = data.toString();
                console.error(`[DOCKER ERR] ${err.trim()}`);
            });
            
            dockerProcess.on('close', (code) => {
                if (deployedApps.length > 0) {
                    resolve({ success: true, email, deployedApps });
                } else if (code === 0) {
                    resolve({ success: true, email, deployedApps: [] });
                } else {
                    reject(new Error(`Docker exited with code ${code}`));
                }
            });
            
            dockerProcess.unref();
            
            setTimeout(() => {
                if (deployedApps.length > 0) {
                    resolve({ success: true, email, deployedApps });
                } else {
                    reject(new Error('Docker deployment timeout'));
                }
            }, 600000);
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
        botStatus.state = 'running';
        
        try {
            await this.initBrowser();
            
            const email = await this.fetchTempEmail();
            botStatus.accountEmail = email;
            
            await this.handleSignup(email, this.password);
            const verifyLink = await this.getVerificationLink();
            
            log('VERIFY', 'Activating account...', 'info', this.instanceId);
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
            
            botStatus.accountCreated = true;
            botStatus.completionTime = new Date();
            botStatus.state = 'completed';
            botStatus.restartCount++;
            
            log('SUCCESS', `✓ Account ${email} created successfully!`, 'success', this.instanceId);
            log('RESTART', `This was account #${botStatus.restartCount}`, 'info', this.instanceId);
            log('RESTART', '========================================', 'info', this.instanceId);
            log('RESTART', 'Restarting container via CLI for NEW IP...', 'info', this.instanceId);
            log('RESTART', '========================================', 'info', this.instanceId);
            
            // Try CLI restart
            const cliSuccess = await restartWithCLI();
            
            if (!cliSuccess) {
                log('RESTART', 'CLI restart failed, using exit restart', 'warn', this.instanceId);
            }
            
            await sleep(2000);
            process.exit(0);
            
        } catch (error) {
            log('ERROR', error.message, 'error', this.instanceId);
            await this.cleanup();
            botStatus.state = 'failed';
            botStatus.completionTime = new Date();
            log('RESTART', 'Account creation failed, exiting...', 'warn', this.instanceId);
            await sleep(2000);
            process.exit(1);
        }
    }
}

// ============ METRICS ENDPOINTS ============
let metrics = { totalAccounts: 0, completedToday: 0 };

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
    res.json({
        totalAccounts: metrics.totalAccounts,
        completedToday: metrics.completedToday,
        botState: botStatus.state,
        accountCreated: botStatus.accountCreated,
        lastAccount: botStatus.accountEmail,
        restartCount: botStatus.restartCount,
        uptime: process.uptime()
    });
});

app.get('/api/accounts', async (req, res) => {
    if (!db) return res.json([]);
    const accounts = await db.collection('accounts')
        .find({ email: { $exists: true, $ne: null } })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();
    res.json(accounts);
});

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Clever Cloud Bot Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
        h1 { font-size: 28px; margin-bottom: 8px; }
        .subtitle { color: #666; margin-bottom: 24px; }
        .card { background: white; border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .card-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
        .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
        .metric-card { background: white; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .metric-value { font-size: 32px; font-weight: 700; color: #1976d2; }
        .metric-label { font-size: 13px; color: #666; margin-top: 8px; }
        .status { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
        .status-running { background: #4caf50; animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #e0e0e0; }
        th { background: #f8f9fa; font-weight: 600; }
        .info-box { background: #e3f2fd; padding: 16px; border-radius: 8px; margin-top: 16px; }
        .info-box p { margin-bottom: 4px; font-size: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 Clever Cloud Bot Dashboard</h1>
        <p class="subtitle">Creates ONE account, auto-handles OAuth, then CLI RESTART for NEW IP</p>
        
        <div class="metrics-grid" id="metrics">
            <div class="metric-card"><div class="metric-value" id="totalAccounts">0</div><div class="metric-label">Total Accounts</div></div>
            <div class="metric-card"><div class="metric-value" id="todayAccounts">0</div><div class="metric-label">Today</div></div>
            <div class="metric-card"><div class="metric-value" id="restartCount">0</div><div class="metric-label">Restarts</div></div>
            <div class="metric-card"><div class="metric-value" id="botState">-</div><div class="metric-label">State</div></div>
        </div>
        
        <div class="card">
            <div class="card-title">📋 Recent Accounts</div>
            <div class="table-responsive">
                <table id="accountsTable">
                    <thead><tr><th>Email</th><th>Password</th><th>Date</th></tr></thead>
                    <tbody id="accountsBody"><tr><td colspan="3">Loading...<\/td><\/tr><\/tbody>
                点able
            <\/div>
        <\/div>
        
        <div class="info-box">
            <p>✅ Bot creates ONE account → Calls Scalingo CLI → IMMEDIATE RESTART</p>
            <p>🔄 Container restarts instantly with NEW IP address</p>
            <p>🔐 OAuth is automatically handled (fills email/password, clicks login)</p>
            <p>🔑 CLI Method: No token needed if already logged in</p>
        <\/div>
    <\/div>
    
    <script>
        async function refreshData() {
            try {
                const res = await fetch('/api/metrics');
                const data = await res.json();
                document.getElementById('totalAccounts').textContent = data.totalAccounts || 0;
                document.getElementById('todayAccounts').textContent = data.completedToday || 0;
                document.getElementById('restartCount').textContent = data.restartCount || 0;
                document.getElementById('botState').innerHTML = '<span class="status status-' + data.botState + '"></span>' + data.botState;
                
                const accountsRes = await fetch('/api/accounts');
                const accounts = await accountsRes.json();
                const tbody = document.getElementById('accountsBody');
                if (accounts && accounts.length) {
                    let html = '';
                    for (const acc of accounts) {
                        html += '<tr>lakang' + acc.email + '<\/td><td>' + acc.password + '<\/td><td>' + new Date(acc.createdAt).toLocaleString() + '<\/td><\/tr>';
                    }
                    tbody.innerHTML = html;
                }
            } catch(e) { console.error(e); }
        }
        refreshData();
        setInterval(refreshData, 5000);
    <\/script>
<\/body>
<\/html>`);
});

// ============ START ============
async function main() {
    console.log(`\n🚀 Clever Cloud Bot Starting...`);
    console.log(`📊 Dashboard: http://localhost:${port}`);
    console.log(`🔄 Mode: Creates ONE account, then CLI RESTART for NEW IP`);
    console.log(`\n`);
    
    await connectMongoDB();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`✅ Dashboard server running on port ${port}`);
    });
    
    await sleep(2000);
    
    const bot = new CleverCloudBot('INSTANCE_1', ENV.BOT_PASSWORD, ENV.BOT_START_DELAY);
    await bot.run();
}

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    if (dbClient) dbClient.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...');
    if (dbClient) dbClient.close();
    process.exit(0);
});

main().catch(console.error);
