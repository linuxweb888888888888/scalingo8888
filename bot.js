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
        if (stats.size > 50000000) return chromePath;
    }
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

function installScalingoCLI() {
    const cliPath = '/app/bin/scalingo';
    if (fs.existsSync(cliPath)) return true;
    try {
        if (!fs.existsSync('/app/bin')) fs.mkdirSync('/app/bin', { recursive: true });
        execSync('curl -L -o /tmp/scalingo.tar.gz https://github.com/Scalingo/cli/releases/download/1.44.1/scalingo_1.44.1_linux_amd64.tar.gz', { stdio: 'inherit' });
        execSync('cd /tmp && tar -xzf scalingo.tar.gz', { stdio: 'inherit' });
        execSync('cp /tmp/scalingo_1.44.1_linux_amd64/scalingo /app/bin/scalingo', { stdio: 'inherit' });
        execSync('chmod +x /app/bin/scalingo', { stdio: 'inherit' });
        execSync('rm -rf /tmp/scalingo_1.44.1_linux_amd64 /tmp/scalingo.tar.gz', { stdio: 'inherit' });
        return true;
    } catch (error) {
        return false;
    }
}

async function restartWithCLI() {
    const cliPath = '/app/bin/scalingo';
    const appName = ENV.SCALINGO_APP_NAME;
    const apiToken = ENV.SCALINGO_API_TOKEN;
    if (!fs.existsSync(cliPath) || !appName || !apiToken) return false;
    return new Promise((resolve) => {
        const cmd = `${cliPath} login --api-token "${apiToken}" && ${cliPath} --app ${appName} restart`;
        const child = spawn('bash', ['-c', cmd]);
        child.on('close', (code) => resolve(code === 0));
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
        if (!this.chromePath) this.chromePath = await installChromiumRuntime();
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
        this.mailPage = await this.browser.newPage();
        await this.mailPage.goto('https://10minutemail.net/', { waitUntil: 'domcontentloaded' });
        await sleep(5000);
        this.realTempEmail = await this.mailPage.evaluate(() => {
            const input = document.querySelector('#fe_text');
            return input ? input.value : document.querySelector('#mailAddress')?.textContent;
        });
        if (!this.realTempEmail) throw new Error('Could not extract email');
        return this.realTempEmail;
    }

    async handleSignup(email, password) {
        await this.page.goto('https://api.clever-cloud.com/v2/sessions/signup', { waitUntil: 'networkidle2' });
        await sleep(3000);
        await this.page.type('input[type="email"]', email);
        await this.page.type('input[type="password"]', password);
        await this.page.evaluate(() => {
            document.querySelector('input[type="checkbox"]')?.click();
            document.querySelector('#altcha_checkbox')?.click();
        });
        for (let i = 0; i < 60; i++) {
            const solved = await this.page.evaluate(() => {
                const input = document.querySelector('input[name="altcha"]');
                return input && input.value?.length > 20;
            });
            if (solved) break;
            await sleep(1000);
        }
        await this.page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(x => x.innerText.toLowerCase().includes('sign up'));
            if (btn) btn.click();
        });
        await sleep(8000);
    }

    async getVerificationLink() {
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
                        if (row.innerText.toLowerCase().includes('clever')) {
                            row.querySelector('a')?.click();
                            return true;
                        }
                    }
                    return false;
                });
                if (clicked) { emailFound = true; await sleep(8000); continue; }
            }
            await sleep(5000);
        }
        throw new Error('Verification timeout');
    }

    async handleOAuth(url, email, password) {
        try {
            const oauthPage = await this.browser.newPage();
            await oauthPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            await sleep(3000);
            await oauthPage.evaluate((e, p) => {
                const ef = document.querySelector('input[type="email"]');
                const pf = document.querySelector('input[type="password"]');
                if (ef && pf) {
                    ef.value = e; pf.value = p;
                    ef.dispatchEvent(new Event('input', { bubbles: true }));
                    pf.dispatchEvent(new Event('input', { bubbles: true }));
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
        } catch (e) { return false; }
    }

    async startDockerInBackground(email, password) {
        return new Promise((resolve, reject) => {
            const dockerProcess = spawn('bash', ['/app/docker'], { 
                detached: true, stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, CLEVER_TOKEN: ENV.CLEVER_TOKEN }
            });
            let deployedApps = [];
            dockerProcess.stdout.on('data', async (data) => {
                const output = data.toString();
                const oauthMatch = output.match(/https:\/\/console\.clever-cloud\.com\/cli-oauth\?[^\s]+/);
                if (oauthMatch && !this.oauthHandled) {
                    this.oauthHandled = true;
                    await this.handleOAuth(oauthMatch[0], email, password);
                }
                const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.osc-fr1\.scalingo\.io/);
                if (urlMatch) deployedApps.push(urlMatch[0]);
                if (output.includes('All 3 apps deployed')) resolve({ success: true, email, deployedApps });
            });
            dockerProcess.on('close', (code) => resolve({ success: code === 0, email, deployedApps }));
            setTimeout(() => resolve({ success: true, email, deployedApps }), 600000);
        });
    }

    async run() {
        if (this.startDelay > 0) await sleep(this.startDelay * 1000);
        botStatus.state = 'running';
        let accountCreated = false;
        try {
            await this.initBrowser();
            const email = await this.fetchTempEmail();
            botStatus.accountEmail = email;
            await this.handleSignup(email, this.password);
            const verifyLink = await this.getVerificationLink();
            await this.page.goto(verifyLink, { waitUntil: 'domcontentloaded' });
            const result = await this.startDockerInBackground(email, this.password);
            if (db) await db.collection('accounts').insertOne({
                email, password: this.password, deployedApps: result.deployedApps, createdAt: new Date()
            });
            accountCreated = true;
            botStatus.accountCreated = true;
        } catch (e) { console.error(e); }
        
        await this.browser?.close();
        botStatus.state = accountCreated ? 'completed' : 'failed';
        botStatus.restartCount++;
        
        await restartWithCLI();
        await sleep(2000);
        process.exit(0);
    }
}

// ============ API ENDPOINTS ============
app.get('/api/metrics', async (req, res) => {
    let total = 0, todayCount = 0;
    if (db) {
        total = await db.collection('accounts').countDocuments();
        const today = new Date(); today.setHours(0,0,0,0);
        todayCount = await db.collection('accounts').countDocuments({ createdAt: { $gte: today } });
    }
    res.json({ totalAccounts: total, completedToday: todayCount, botState: botStatus.state, restartCount: botStatus.restartCount });
});

app.get('/api/accounts', async (req, res) => {
    if (!db) return res.json([]);
    const accounts = await db.collection('accounts').find().sort({ createdAt: -1 }).limit(50).toArray();
    res.json(accounts);
});

// ============ DASHBOARD (MATERIAL DESIGN) ============
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CleverBot Admin</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
    <style>
        :root { --primary: #6200ee; --bg: #f4f7f9; --surface: #ffffff; --text-sec: #757575; --shadow: 0px 3px 6px rgba(0,0,0,0.16); }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Roboto', sans-serif; background: var(--bg); color: #202124; }
        header { background: var(--primary); color: white; padding: 16px 24px; box-shadow: var(--shadow); display: flex; align-items: center; position: sticky; top: 0; z-index: 100; }
        header i { margin-right: 12px; }
        header h1 { font-size: 20px; font-weight: 500; }
        .container { max-width: 1000px; margin: 32px auto; padding: 0 16px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 32px; }
        .card { background: var(--surface); border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
        .label { font-size: 12px; color: var(--text-sec); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
        .value { font-size: 32px; font-weight: 700; color: var(--primary); margin-top: 4px; }
        .badge { display: inline-flex; align-items: center; padding: 4px 12px; border-radius: 16px; font-size: 12px; font-weight: 700; margin-top: 8px; text-transform: uppercase; }
        .status-running { background: #e8f5e9; color: #2e7d32; }
        .status-starting { background: #fff3e0; color: #ef6c00; }
        .status-failed { background: #ffebee; color: #c62828; }
        .pulse { width: 8px; height: 8px; background: currentColor; border-radius: 50%; margin-right: 8px; animation: p 1.5s infinite; }
        @keyframes p { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .main-card { background: var(--surface); border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.12); overflow: hidden; }
        .card-head { padding: 16px 24px; border-bottom: 1px solid #eee; display: flex; align-items: center; justify-content: space-between; }
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 12px 24px; background: #f8f9fa; font-size: 12px; color: var(--text-sec); }
        td { padding: 16px 24px; border-bottom: 1px solid #eee; font-size: 14px; }
        tr:hover { background: #fcfcfc; }
    </style>
</head>
<body>
    <header><i class="material-icons">settings_input_component</i><h1>Clever Cloud Automation</h1></header>
    <div class="container">
        <div class="grid">
            <div class="card"><div class="label">Total Accounts</div><div class="value" id="totalAccounts">0</div></div>
            <div class="card"><div class="label">New Today</div><div class="value" id="todayAccounts">0</div></div>
            <div class="card"><div class="label">Restarts</div><div class="value" id="restartCount">0</div></div>
            <div class="card"><div class="label">Current Status</div><div id="statusBox"></div></div>
        </div>
        <div class="main-card">
            <div class="card-head"><h3>Account History</h3><i class="material-icons" style="color:var(--text-sec)">history</i></div>
            <table id="accTable">
                <thead><tr><th>EMAIL ADDRESS</th><th>PASSWORD</th><th>CREATED AT</th></tr></thead>
                <tbody id="accBody"></tbody>
            </table>
        </div>
    </div>
    <script>
        async function update() {
            const res = await fetch('/api/metrics'); const d = await res.json();
            document.getElementById('totalAccounts').innerText = d.totalAccounts;
            document.getElementById('todayAccounts').innerText = d.completedToday;
            document.getElementById('restartCount').innerText = d.restartCount;
            const s = d.botState || 'starting';
            document.getElementById('statusBox').innerHTML = \`<span class="badge status-\${s}"><div class="pulse"></div>\${s}</span>\`;
            
            const aRes = await fetch('/api/accounts'); const a = await aRes.json();
            document.getElementById('accBody').innerHTML = a.map(x => \`
                <tr>
                    <td style="color:var(--primary); font-weight:500">\${x.email}</td>
                    <td style="font-family:monospace">\${x.password}</td>
                    <td style="color:var(--text-sec)">\${new Date(x.createdAt).toLocaleString()}</td>
                </tr>
            \`).join('');
        }
        setInterval(update, 5000); update();
    </script>
</body>
</html>`);
});

// ============ MAIN START ============
async function main() {
    installScalingoCLI();
    await connectMongoDB();
    app.listen(port, '0.0.0.0', () => console.log(`Server on port ${port}`));
    const bot = new CleverCloudBot('INSTANCE_1', ENV.BOT_PASSWORD, ENV.BOT_START_DELAY);
    await bot.run();
}

main().catch(console.error);
