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
console.log(`Bot Mode: Creates ONE account, then fails health check to trigger restart`);
console.log(`MongoDB: ${MONGODB_URI ? 'Connected' : 'Not configured'}`);
console.log('========================================\n');

// ============ STATE VARIABLES ============
let botStatus = {
    state: 'starting', // starting, running, completed, failed
    accountCreated: false,
    accountEmail: null,
    startTime: new Date(),
    completionTime: null
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
        botStatus.state = 'running';
        
        try {
            await this.initBrowser();
            
            const email = await this.fetchTempEmail();
            botStatus.accountEmail = email;
            
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
            
            botStatus.accountCreated = true;
            botStatus.completionTime = new Date();
            botStatus.state = 'completed';
            
            log('SUCCESS', `✓ Account ${email} created successfully!`, 'success', this.instanceId);
            log('RESTART', '========================================', 'info', this.instanceId);
            log('RESTART', 'Account creation complete!', 'info', this.instanceId);
            log('RESTART', 'Health check will now fail to trigger restart', 'info', this.instanceId);
            log('RESTART', 'Scalingo will restart container with NEW IP', 'info', this.instanceId);
            log('RESTART', 'Next account will have a different IP', 'info', this.instanceId);
            log('RESTART', '========================================', 'info', this.instanceId);
            
        } catch (error) {
            log('ERROR', error.message, 'error', this.instanceId);
            await this.cleanup();
            botStatus.state = 'failed';
            botStatus.completionTime = new Date();
            
            log('RESTART', '========================================', 'info', this.instanceId);
            log('RESTART', 'Account creation failed!', 'error', this.instanceId);
            log('RESTART', 'Health check will fail to trigger restart', 'info', this.instanceId);
            log('RESTART', 'Scalingo will restart container to retry', 'info', this.instanceId);
            log('RESTART', '========================================', 'info', this.instanceId);
        }
    }
}

// ============ HEALTH CHECK ENDPOINT ============
// This endpoint controls when Scalingo restarts the container
// - Returns 200 while bot is working (healthy)
// - Returns 500 after bot completes (unhealthy -> triggers restart)
app.get('/health', (req, res) => {
    const uptime = process.uptime();
    
    console.log(`[HEALTH] State: ${botStatus.state}, Account: ${botStatus.accountCreated ? 'created' : 'not yet'}, Uptime: ${Math.floor(uptime)}s`);
    
    if (botStatus.state === 'starting') {
        // Bot still starting up - healthy
        res.status(200).json({ 
            status: 'starting', 
            healthy: true,
            uptime: uptime,
            message: 'Bot is starting up'
        });
    } 
    else if (botStatus.state === 'running') {
        // Bot is actively creating account - healthy
        res.status(200).json({ 
            status: 'running', 
            healthy: true,
            uptime: uptime,
            message: 'Bot is creating account'
        });
    }
    else if (botStatus.state === 'completed') {
        // Bot completed successfully - return 500 to trigger restart for NEW IP
        console.log('[HEALTH] Bot completed, returning 500 to trigger restart for new IP');
        res.status(500).json({ 
            status: 'completed', 
            healthy: false,
            uptime: uptime,
            message: 'Account created, restarting for new IP',
            accountCreated: botStatus.accountEmail
        });
    }
    else if (botStatus.state === 'failed') {
        // Bot failed - return 500 to trigger restart
        console.log('[HEALTH] Bot failed, returning 500 to trigger restart');
        res.status(500).json({ 
            status: 'failed', 
            healthy: false,
            uptime: uptime,
            message: 'Account creation failed, restarting to retry'
        });
    }
    else {
        // Unknown state - return 500 to be safe
        res.status(500).json({ 
            status: 'unknown', 
            healthy: false,
            uptime: uptime
        });
    }
});

// ============ READINESS CHECK ENDPOINT ============
app.get('/ready', (req, res) => {
    if (botStatus.state === 'running' || botStatus.state === 'starting') {
        res.status(200).json({ ready: true });
    } else {
        res.status(503).json({ ready: false });
    }
});

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
        ...metrics,
        botState: botStatus.state,
        accountCreated: botStatus.accountCreated,
        lastAccount: botStatus.accountEmail,
        uptime: process.uptime()
    });
});

app.get('/api/accounts', async (req, res) => {
    if (!db) return res.json([]);
    const accounts = await db.collection('accounts').find({}).sort({ createdAt: -1 }).limit(50).toArray();
    res.json(accounts);
});

app.get('/api/status', (req, res) => {
    res.json({
        botState: botStatus.state,
        accountCreated: botStatus.accountCreated,
        accountEmail: botStatus.accountEmail,
        startTime: botStatus.startTime,
        completionTime: botStatus.completionTime,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        willRestart: botStatus.state === 'completed' || botStatus.state === 'failed'
    });
});

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Clever Cloud Bot - Health Check Restart</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #1e1e2f; }
        .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
        h1 { font-size: 28px; font-weight: 600; margin-bottom: 8px; }
        .subtitle { color: #666; margin-bottom: 24px; }
        .card { background: white; border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .card-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
        .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
        .metric-card { background: white; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .metric-value { font-size: 32px; font-weight: 700; color: #1976d2; }
        .metric-label { font-size: 13px; color: #666; margin-top: 8px; }
        .status { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
        .status-starting { background: #ff9800; animation: pulse 1s infinite; }
        .status-running { background: #4caf50; animation: pulse 2s infinite; }
        .status-completed { background: #2196f3; }
        .status-failed { background: #f44336; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #e0e0e0; }
        th { background: #f8f9fa; font-weight: 600; }
        .info-box { background: #e3f2fd; padding: 16px; border-radius: 8px; margin-top: 16px; }
        .info-box h4 { margin-bottom: 8px; color: #1976d2; }
        .info-box p { margin-bottom: 4px; font-size: 14px; color: #555; }
        code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 Clever Cloud Bot</h1>
        <p class="subtitle">Creates ONE account, then health check triggers restart for NEW IP</p>
        
        <div class="metrics-grid" id="metrics">
            <div class="metric-card"><div class="metric-value" id="totalAccounts">0</div><div class="metric-label">Total Accounts</div></div>
            <div class="metric-card"><div class="metric-value" id="todayAccounts">0</div><div class="metric-label">Today</div></div>
            <div class="metric-card"><div class="metric-value" id="uptime">0s</div><div class="metric-label">Uptime</div></div>
            <div class="metric-card"><div class="metric-value" id="botState">-</div><div class="metric-label">Bot State</div></div>
        </div>
        
        <div class="card">
            <div class="card-title">📊 System Status</div>
            <div id="statusDetails"></div>
        </div>
        
        <div class="card">
            <div class="card-title">📋 Recent Accounts</div>
            <div class="table-responsive">
                <table id="accountsTable">
                    <thead><tr><th>Email</th><th>Password</th><th>Date</th></tr></thead>
                    <tbody id="accountsBody"><tr><td colspan="3">Loading...</td></tr></tbody>
                </table>
            </div>
        </div>
        
        <div class="info-box">
            <h4>🔄 How Restart Works</h4>
            <p>1. Bot creates ONE Clever Cloud account</p>
            <p>2. After completion, health check returns <code>500</code> (unhealthy)</p>
            <p>3. Scalingo detects unhealthy container and restarts it</p>
            <p>4. Container gets a <strong>NEW PUBLIC IP</strong> address</p>
            <p>5. Bot starts again and creates another account</p>
            <p>📡 Health check endpoint: <code>/health</code> | Every few seconds</p>
        </div>
    </div>
    
    <script>
        async function loadMetrics() {
            try {
                const res = await fetch('/api/metrics');
                const data = await res.json();
                document.getElementById('totalAccounts').textContent = data.totalAccounts || 0;
                document.getElementById('todayAccounts').textContent = data.completedToday || 0;
                document.getElementById('uptime').textContent = Math.floor(data.uptime) + 's';
                
                const stateSpan = document.getElementById('botState');
                const state = data.botState || 'unknown';
                stateSpan.innerHTML = \`<span class="status status-\${state}\"></span>\${state}\`;
            } catch(e) { console.error(e); }
        }
        
        async function loadStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                const statusHtml = \`
                    <p><strong>Bot State:</strong> <span class="status status-\${data.botState}\"></span> \${data.botState}</p>
                    <p><strong>Account Created:</strong> \${data.accountCreated ? '✅ Yes' : '⏳ Not yet'}</p>
                    <p><strong>Account Email:</strong> \${data.accountEmail || '-'}</p>
                    <p><strong>Started:</strong> \${new Date(data.startTime).toLocaleString()}</p>
                    <p><strong>Will Restart:</strong> \${data.willRestart ? '🔄 Yes (new IP coming)' : '❌ No'}</p>
                    <p><strong>Memory Usage:</strong> \${Math.round(data.memory?.heapUsed / 1024 / 1024)} MB / \${Math.round(data.memory?.heapTotal / 1024 / 1024)} MB</p>
                \`;
                document.getElementById('statusDetails').innerHTML = statusHtml;
            } catch(e) { console.error(e); }
        }
        
        async function loadAccounts() {
            try {
                const res = await fetch('/api/accounts');
                const accounts = await res.json();
                const tbody = document.getElementById('accountsBody');
                if (!accounts || accounts.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="3">No accounts yet</td></tr>';
                    return;
                }
                tbody.innerHTML = accounts.map(acc => \`
                    <tr>
                        <td>\${acc.email}</td>
                        <td>\${acc.password}</td>
                        <td>\${new Date(acc.createdAt).toLocaleString()}</td>
                    </tr>
                \`).join('');
            } catch(e) { console.error(e); }
        }
        
        function refresh() {
            loadMetrics();
            loadStatus();
            loadAccounts();
        }
        
        refresh();
        setInterval(refresh, 5000);
    </script>
</body>
</html>`);
});

// ============ START THE BOT ============
async function main() {
    console.log(`\n🚀 Clever Cloud Bot Starting...`);
    console.log(`📊 Dashboard: http://localhost:${port}`);
    console.log(`🩺 Health Check: http://localhost:${port}/health`);
    console.log(`🔄 Mode: Creates ONE account, then health check triggers restart for NEW IP`);
    console.log(`\n`);
    
    await connectMongoDB();
    
    // Start the Express server first
    app.listen(port, '0.0.0.0', () => {
        console.log(`✅ Dashboard server running on port ${port}`);
        console.log(`\n📡 Health check endpoint: /health`);
        console.log(`   - Returns 200 while bot is working`);
        console.log(`   - Returns 500 after account created → triggers restart`);
        console.log(`   - Container restarts with NEW IP address\n`);
    });
    
    // Wait a moment for server to start
    await sleep(2000);
    
    // Run the bot
    const bot = new CleverCloudBot('INSTANCE_1', ENV.BOT_PASSWORD, ENV.BOT_START_DELAY);
    await bot.run();
    
    // Keep process alive for health checks
    console.log('[MAIN] Bot completed, keeping process alive for health checks...');
    console.log('[MAIN] Health check will now return 500, triggering restart for new IP');
    
    // Keep the process running indefinitely (health checks will trigger restart)
    setInterval(() => {
        // Just keep alive
    }, 1000);
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down...');
    if (dbClient) dbClient.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, shutting down...');
    if (dbClient) dbClient.close();
    process.exit(0);
});

main().catch(console.error);
