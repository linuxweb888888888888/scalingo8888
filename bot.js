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
    SCALINGO_API_TOKEN: process.env.SCALINGO_API_TOKEN || '',
    SCALINGO_APP_NAME: process.env.SCALINGO_APP_NAME || ''
};

console.log('\n========================================');
console.log('  BOT CONFIGURATION');
console.log('========================================');
console.log(`Bot Mode: Creates ONE account, then CLI RESTART for NEW IP`);
console.log(`MongoDB: ${MONGODB_URI ? 'Connected' : 'Not configured'}`);
console.log(`Clever Token: ${ENV.CLEVER_TOKEN ? '✓ Configured' : '✗ Not configured'}`);
console.log(`Scalingo App: ${ENV.SCALINGO_APP_NAME || 'Not set'}`);
console.log(`Scalingo API Token: ${ENV.SCALINGO_API_TOKEN ? '✓ Configured' : '✗ Not configured'}`);
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

// ============ INSTALL SCALINGO CLI AT RUNTIME ============
function installScalingoCLI() {
    const cliPath = '/app/bin/scalingo';
    
    if (fs.existsSync(cliPath)) {
        console.log('[CLI] Scalingo CLI already installed');
        return true;
    }
    
    console.log('[CLI] Installing Scalingo CLI...');
    
    try {
        if (!fs.existsSync('/app/bin')) {
            fs.mkdirSync('/app/bin', { recursive: true });
        }
        
        console.log('[CLI] Downloading...');
        execSync('curl -L -o /tmp/scalingo.tar.gz https://github.com/Scalingo/cli/releases/download/1.44.1/scalingo_1.44.1_linux_amd64.tar.gz', { stdio: 'inherit' });
        
        console.log('[CLI] Extracting...');
        execSync('cd /tmp && tar -xzf scalingo.tar.gz', { stdio: 'inherit' });
        
        console.log('[CLI] Copying binary...');
        execSync('cp /tmp/scalingo_1.44.1_linux_amd64/scalingo /app/bin/scalingo', { stdio: 'inherit' });
        
        execSync('chmod +x /app/bin/scalingo', { stdio: 'inherit' });
        execSync('rm -rf /tmp/scalingo_1.44.1_linux_amd64 /tmp/scalingo.tar.gz', { stdio: 'inherit' });
        
        console.log('[CLI] ✅ Scalingo CLI installed successfully');
        return true;
        
    } catch (error) {
        console.error('[CLI] Failed to install:', error.message);
        return false;
    }
}

// ============ RESTART VIA CLI ============
async function restartWithCLI() {
    const cliPath = '/app/bin/scalingo';
    const appName = ENV.SCALINGO_APP_NAME;
    const apiToken = ENV.SCALINGO_API_TOKEN;
    
    if (!fs.existsSync(cliPath)) {
        log('RESTART', 'Scalingo CLI not found', 'error', 'MAIN');
        return false;
    }
    
    if (!appName || !apiToken) {
        log('RESTART', 'Missing App Name or Token', 'error', 'MAIN');
        return false;
    }
    
    log('RESTART', `Restarting ${appName} via CLI...`, 'info', 'MAIN');
    
    return new Promise((resolve) => {
        const cmd = `${cliPath} login --api-token "${apiToken}" && ${cliPath} --app ${appName} restart`;
        const child = spawn('bash', ['-c', cmd]);
        
        child.on('close', (code) => {
            if (code === 0) {
                log('RESTART', '✅ CLI restart initiated successfully!', 'success', 'MAIN');
                resolve(true);
            } else {
                log('RESTART', `CLI restart failed code ${code}`, 'error', 'MAIN');
                resolve(false);
            }
        });
    });
}

// ============ TEST SCALINGO CLI ============
function testScalingoCLI() {
    const cliPath = '/app/bin/scalingo';
    if (fs.existsSync(cliPath)) {
        try {
            const version = execSync(`${cliPath} version`, { encoding: 'utf8' });
            console.log(`✅ Scalingo CLI version: ${version.trim()}`);
        } catch(e) {}
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
        
        if (!this.realTempEmail) throw new Error('Could not extract email');
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
            const cb = document.querySelector('#altcha_checkbox');
            if (cb) cb.click();
        });
        
        log('CAPTCHA', 'Waiting for solution...', 'info', this.instanceId);
        for (let i = 0; i < 60; i++) {
            const solved = await this.page.evaluate(() => {
                const input = document.querySelector('input[name="altcha"]');
                return input && input.value && input.value.length > 20;
            });
            if (solved) break;
            await sleep(1000);
        }
        
        await this.page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(x => x.innerText.toLowerCase().includes('sign up'));
            if (btn) btn.click();
        });
        
        await sleep(8000);
        log('SIGNUP', 'Form submitted', 'success', this.instanceId);
    }

    async getVerificationLink() {
        log('VERIFY', 'Waiting for email...', 'info', this.instanceId);
        const startTime = Date.now();
        let emailFound = false;
        
        while (Date.now() - startTime < 180000) {
            let link = await this.mailPage.evaluate(() => {
                const regex = /https:\/\/api\.clever-cloud\.com\/v2\/self\/validate_email\?validationKey=[a-f0-9-]+/;
                const match = document.documentElement.innerHTML.match(regex);
                return match ? match[0] : null;
            });
            
            if (link) return link;
            
            if (!emailFound) {
                const clicked = await this.mailPage.evaluate(() => {
                    const rows = Array.from(document.querySelectorAll('#maillist tr'));
                    for (const row of rows) {
                        const text = row.innerText.toLowerCase();
                        if (text.includes('clever')) {
                            const a = row.querySelector('a');
                            if (a) { a.click(); return true; }
                        }
                    }
                    return false;
                });
                if (clicked) { emailFound = true; await sleep(8000); continue; }
            }
            await sleep(5000);
        }
        throw new Error('No verification email');
    }

    async handleOAuth(url, email, password) {
        log('OAUTH', 'Handling Login...', 'info', this.instanceId);
        try {
            const oauthPage = await this.browser.newPage();
            await oauthPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            await sleep(3000);
            
            await oauthPage.evaluate((email, password) => {
                const emailField = document.querySelector('input[type="email"]');
                const passwordField = document.querySelector('input[type="password"]');
                if (emailField && passwordField) {
                    emailField.value = email;
                    passwordField.value = password;
                    emailField.dispatchEvent(new Event('input', { bubbles: true }));
                    passwordField.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }, email, password);
            
            await sleep(2000);
            await oauthPage.evaluate(() => {
                const btn = document.querySelector('button, input[type="submit"]');
                if (btn) btn.click();
            });
            
            await sleep(8000);
            await oauthPage.close();
            return true;
        } catch (error) {
            return false;
        }
    }

    async startDockerInBackground(email, password) {
        return new Promise((resolve, reject) => {
            log('DOCKER', 'Starting deployment script...', 'info', this.instanceId);
            const dockerProcess = spawn('bash', ['/app/docker'], { 
                detached: true, stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, CLEVER_TOKEN: ENV.CLEVER_TOKEN }
            });
            
            let deployedApps = [];
            dockerProcess.stdout.on('data', async (data) => {
                const output = data.toString();
                const oauthUrlMatch = output.match(/https:\/\/console\.clever-cloud\.com\/cli-oauth\?[^\s]+/);
                if (oauthUrlMatch && !this.oauthHandled) {
                    this.oauthHandled = true;
                    await this.handleOAuth(oauthUrlMatch[0], email, password);
                }
                const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.osc-fr1\.scalingo\.io/);
                if (urlMatch) deployedApps.push(urlMatch[0]);
                if (output.includes('All 3 apps deployed')) resolve({ success: true, email, deployedApps });
            });
            
            dockerProcess.on('close', (code) => resolve({ success: true, email, deployedApps }));
            setTimeout(() => resolve({ success: true, email, deployedApps }), 600000);
        });
    }

    async cleanup() {
        if (this.browser) await this.browser.close();
    }

    async run() {
        if (this.startDelay > 0) await sleep(this.startDelay * 1000);
        botStatus.state = 'running';
        
        let accountCreated = false;
        let accountEmail = null;
        
        try {
            await this.initBrowser();
            accountEmail = await this.fetchTempEmail();
            botStatus.accountEmail = accountEmail;
            
            await this.handleSignup(accountEmail, this.password);
            const verifyLink = await this.getVerificationLink();
            
            log('VERIFY', 'Activating...', 'info', this.instanceId);
            await this.page.goto(verifyLink, { waitUntil: 'domcontentloaded' });
            await sleep(5000);
            
            const result = await this.startDockerInBackground(accountEmail, this.password);
            
            if (db) {
                await db.collection('accounts').insertOne({
                    email: accountEmail,
                    password: this.password,
                    deployedApps: result.deployedApps || [],
                    createdAt: new Date()
                });
            }
            accountCreated = true;
            botStatus.accountCreated = true;
        } catch (error) {
            log('ERROR', error.message, 'error', this.instanceId);
        }
        
        await this.cleanup();
        botStatus.state = accountCreated ? 'completed' : 'failed';
        botStatus.restartCount++;
        
        await restartWithCLI();
        process.exit(0);
    }
}

// ============ ENDPOINTS ============
app.get('/api/metrics', async (req, res) => {
    let total = 0, today = 0;
    if (db) {
        total = await db.collection('accounts').countDocuments();
        const start = new Date(); start.setHours(0,0,0,0);
        today = await db.collection('accounts').countDocuments({ createdAt: { $gte: start } });
    }
    res.json({ totalAccounts: total, completedToday: today, botState: botStatus.state, restartCount: botStatus.restartCount });
});

app.get('/api/accounts', async (req, res) => {
    if (!db) return res.json([]);
    const accounts = await db.collection('accounts').find().sort({ createdAt: -1 }).limit(50).toArray();
    res.json(accounts);
});

// ============ MATERIAL DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Automation Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
    <style>
        :root { --primary: #6200ee; --bg: #f4f7f9; --surface: #ffffff; --text: #202124; --shadow: 0px 3px 5px -1px rgba(0,0,0,0.1), 0px 6px 10px 0px rgba(0,0,0,0.07); }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Roboto', sans-serif; background: var(--bg); color: var(--text); }
        header { background: var(--primary); color: white; padding: 16px 24px; box-shadow: var(--shadow); display: flex; align-items: center; position: sticky; top: 0; z-index: 100; }
        header i { margin-right: 16px; }
        header h1 { font-size: 20px; font-weight: 500; }
        .container { max-width: 1100px; margin: 32px auto; padding: 0 24px; }
        .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 24px; margin-bottom: 32px; }
        .m-card { background: var(--surface); padding: 24px; border-radius: 8px; box-shadow: var(--shadow); transition: 0.3s; }
        .m-label { font-size: 12px; color: #757575; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px; }
        .m-value { font-size: 36px; font-weight: 700; color: var(--primary); margin-top: 8px; }
        .badge { display: inline-flex; align-items: center; padding: 6px 12px; border-radius: 16px; font-size: 12px; font-weight: 700; text-transform: uppercase; margin-top: 8px; }
        .status-running { background: #e8f5e9; color: #2e7d32; }
        .status-starting { background: #fff3e0; color: #ef6c00; }
        .pulse { width: 8px; height: 8px; background: currentColor; border-radius: 50%; margin-right: 8px; animation: p 1.5s infinite; }
        @keyframes p { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .table-card { background: var(--surface); border-radius: 8px; box-shadow: var(--shadow); overflow: hidden; }
        .t-header { padding: 20px 24px; border-bottom: 1px solid #eee; display: flex; align-items: center; justify-content: space-between; }
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 12px 24px; background: #f8f9fa; font-size: 12px; color: #757575; }
        td { padding: 16px 24px; border-bottom: 1px solid #eee; font-size: 14px; }
        tr:hover { background: #fafafa; }
    </style>
</head>
<body>
    <header><i class="material-icons">memory</i><h1>Clever Automation System</h1></header>
    <div class="container">
        <div class="metrics">
            <div class="m-card"><div class="m-label">Total Accounts</div><div class="m-value" id="total">0</div></div>
            <div class="m-card"><div class="m-label">Success Today</div><div class="m-value" id="today">0</div></div>
            <div class="m-card"><div class="m-label">IP Rotations</div><div class="m-value" id="restarts">0</div></div>
            <div class="m-card"><div class="m-label">Bot State</div><div id="status"></div></div>
        </div>
        <div class="table-card">
            <div class="t-header"><h3>Recent Deployments</h3><i class="material-icons" style="color:#757575">dns</i></div>
            <table>
                <thead><tr><th>EMAIL ADDRESS</th><th>PASSWORD</th><th>CREATED</th></tr></thead>
                <tbody id="rows"></tbody>
            </table>
        </div>
    </div>
    <script>
        async function update() {
            try {
                const m = await (await fetch('/api/metrics')).json();
                document.getElementById('total').innerText = m.totalAccounts;
                document.getElementById('today').innerText = m.completedToday;
                document.getElementById('restarts').innerText = m.restartCount;
                document.getElementById('status').innerHTML = '<span class="badge status-'+m.botState+'"><div class="pulse"></div>'+m.botState+'</span>';
                
                const a = await (await fetch('/api/accounts')).json();
                document.getElementById('rows').innerHTML = a.map(acc => \`
                    <tr>
                        <td style="font-weight:500; color:var(--primary)">\${acc.email}</td>
                        <td style="font-family:monospace">\${acc.password}</td>
                        <td style="color:#757575">\${new Date(acc.createdAt).toLocaleString()}</td>
                    </tr>
                \`).join('');
            } catch(e){}
        }
        setInterval(update, 5000); update();
    </script>
</body>
</html>`);
});

// ============ START ============
async function main() {
    installScalingoCLI();
    testScalingoCLI();
    await connectMongoDB();
    app.listen(port, '0.0.0.0', () => console.log(`✅ Server running on port ${port}`));
    const bot = new CleverCloudBot('INSTANCE_1', ENV.BOT_PASSWORD, ENV.BOT_START_DELAY);
    await bot.run();
}

main().catch(console.error);
