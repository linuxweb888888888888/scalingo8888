// single-bot-system.js - DEPLOY THIS EXACT SAME FILE EVERYWHERE

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

// ============ AUTO-DETECT CENTRAL MODE ============
const CENTRAL_DOMAIN = 'business-app.osc-fr1.scalingo.io';
const CURRENT_HOSTNAME = os.hostname();
const IS_CENTRAL_SERVER = CURRENT_HOSTNAME.includes('business-app') || 
                           process.env.IS_CENTRAL === 'true' ||
                           (process.env.DOMAIN && process.env.DOMAIN.includes('business-app'));

console.log('\n========================================');
console.log('  BOT SYSTEM DEPLOYMENT');
console.log('========================================');
console.log(`Current Hostname: ${CURRENT_HOSTNAME}`);
console.log(`Central Domain: ${CENTRAL_DOMAIN}`);
console.log(`Mode: ${IS_CENTRAL_SERVER ? '🔵 CENTRAL SERVER (Dashboard + Bot Worker)' : '🟢 BOT WORKER (Account Creator Only)'}`);
console.log('========================================\n');

// ============ PERSISTENT DEPLOYMENT ID (Prevents duplicates) ============
const PERSISTENT_ID_FILE = '/app/.deployment_id';
let persistentDeploymentId = `bot-${CURRENT_HOSTNAME}-${Date.now()}`; // fallback

if (!IS_CENTRAL_SERVER) {
    try {
        if (fs.existsSync(PERSISTENT_ID_FILE)) {
            persistentDeploymentId = fs.readFileSync(PERSISTENT_ID_FILE, 'utf8').trim();
            console.log(`[ID] Using existing deployment ID: ${persistentDeploymentId}`);
        } else {
            persistentDeploymentId = `worker-${CURRENT_HOSTNAME}`;
            fs.writeFileSync(PERSISTENT_ID_FILE, persistentDeploymentId);
            console.log(`[ID] Created new persistent deployment ID: ${persistentDeploymentId}`);
        }
    } catch (error) {
        console.log(`[ID] Could not persist ID, using: ${persistentDeploymentId}`);
    }
} else {
    persistentDeploymentId = `central-${CURRENT_HOSTNAME}`;
    console.log(`[ID] Central server ID: ${persistentDeploymentId}`);
}

// ============ ENVIRONMENT VARIABLES ============
const ENV = {
    IS_CENTRAL: IS_CENTRAL_SERVER,
    
    BOT_PASSWORD: process.env.BOT_PASSWORD || 'Linuxdistro&84',
    BOT_START_DELAY: parseInt(process.env.BOT_START_DELAY) || 5,
    HEADLESS_MODE: process.env.HEADLESS_MODE !== 'false',
    CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/app/chrome-linux64/chrome',
    CLEVER_TOKEN: process.env.CLEVER_TOKEN || '',
    
    CLI_RESTART_ENABLED: IS_CENTRAL_SERVER && process.env.CLI_RESTART_ENABLED === 'true',
    SCALINGO_API_TOKEN: process.env.SCALINGO_API_TOKEN || '',
    SCALINGO_APP_NAME: process.env.SCALINGO_APP_NAME || '',
    
    DEPLOYMENT_ID: persistentDeploymentId,
    DEPLOYMENT_NAME: process.env.DEPLOYMENT_NAME || CURRENT_HOSTNAME,
    DEPLOYMENT_REGION: process.env.DEPLOYMENT_REGION || 'osc-fr1',
    
    CENTRAL_API_URL: process.env.CENTRAL_API_URL || `https://${CENTRAL_DOMAIN}`,
    CENTRAL_API_KEY: process.env.CENTRAL_API_KEY || 'change-this-secret-key-12345',
    
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888'
};

console.log('Configuration:');
console.log(`  CLI Restart Enabled: ${ENV.CLI_RESTART_ENABLED ? 'YES (Central Server Only)' : 'NO (Workers Run Continuously)'}`);
console.log(`  Headless Mode: ${ENV.HEADLESS_MODE ? 'YES' : 'NO'}`);
console.log(`  Clever Token: ${ENV.CLEVER_TOKEN ? '✓ Configured (Token auth)' : '✗ Not configured'}`);
console.log(`  Deployment ID: ${ENV.DEPLOYMENT_ID}`);
if (!ENV.IS_CENTRAL) {
    console.log(`  Web Server: DISABLED (Worker mode - no HTTP server)`);
}
console.log('========================================\n');

// ============ MONGODB CONNECTION ============
let dbClient = null;
let db = null;

async function connectMongoDB() {
    try {
        dbClient = new MongoClient(ENV.MONGODB_URI);
        await dbClient.connect();
        db = dbClient.db('botdb');
        console.log('[MongoDB] Connected successfully');
        
        await db.createCollection('accounts', { capped: false });
        await db.createCollection('metrics', { capped: false });
        await db.createCollection('deployments', { capped: false });
        await db.collection('accounts').createIndex({ createdAt: -1 });
        await db.collection('accounts').createIndex({ deploymentId: 1 });
        await db.collection('deployments').createIndex({ lastHeartbeat: -1 });
        await db.collection('deployments').createIndex({ deploymentId: 1 });
        
        return true;
    } catch (error) {
        console.error('[MongoDB] Connection failed:', error.message);
        return false;
    }
}

// ============ STATE VARIABLES ============
let botStatus = {
    state: 'running',
    accountCreated: false,
    accountEmail: null,
    startTime: new Date(),
    completionTime: null,
    totalAccounts: 0,
    deploymentId: ENV.DEPLOYMENT_ID,
    deploymentName: ENV.DEPLOYMENT_NAME,
    region: ENV.DEPLOYMENT_REGION,
    isCentral: ENV.IS_CENTRAL
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

// Clean up stale deployments and duplicates
async function cleanupStaleDeployments() {
    try {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const result = await db.collection('deployments').deleteMany({
            lastHeartbeat: { $lt: fiveMinutesAgo }
        });
        if (result.deletedCount > 0) {
            console.log(`[Cleanup] Removed ${result.deletedCount} stale deployment(s)`);
        }
    } catch (error) {
        console.error('[Cleanup] Failed to clean stale deployments:', error.message);
    }
}

async function cleanupDuplicateDeployments() {
    try {
        const deployments = await db.collection('deployments').find({}).toArray();
        const seenIds = new Set();
        const toDelete = [];
        
        for (const deployment of deployments) {
            if (seenIds.has(deployment.deploymentId)) {
                toDelete.push(deployment._id);
            } else {
                seenIds.add(deployment.deploymentId);
            }
        }
        
        if (toDelete.length > 0) {
            await db.collection('deployments').deleteMany({ _id: { $in: toDelete } });
            console.log(`[Cleanup] Removed ${toDelete.length} duplicate deployment(s)`);
        }
    } catch (error) {
        console.error('[Cleanup] Failed to clean duplicates:', error.message);
    }
}

// Install all Chrome dependencies
async function installChromeDependencies() {
    console.log('[SYSTEM] Installing Chrome dependencies...');
    try {
        execSync('apt-get update -qq 2>/dev/null || true', { stdio: 'inherit' });
        execSync(`apt-get install -y -qq --no-install-recommends \
            git wget curl gnupg apt-transport-https ca-certificates unzip \
            npm nodejs \
            libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
            libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
            libgbm1 libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
            libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libgcc-s1 libglib2.0-0 \
            libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
            libxshmfence1 libxkbcommon0 libxcb-dri3-0 fonts-liberation \
            libappindicator3-1 libnss3-tools xdg-utils 2>/dev/null || true`, 
        { stdio: 'inherit' });
        console.log('[SYSTEM] Dependencies installed successfully');
        return true;
    } catch (error) {
        console.log('[SYSTEM] Warning: Some dependencies may already be installed');
        return false;
    }
}

// Install Clever Cloud CLI using npm
async function installCleverCLI() {
    console.log('[CLI] Installing Clever Cloud CLI via npm...');
    try {
        execSync('npm install -g clever-tools', { stdio: 'inherit' });
        console.log('[CLI] ✅ Clever CLI installed successfully');
        
        const version = execSync('clever --version', { encoding: 'utf8' });
        console.log(`[CLI] Clever version: ${version.trim()}`);
        
        return true;
    } catch (error) {
        console.error('[CLI] Failed to install Clever CLI:', error.message);
        return false;
    }
}

// Login to Clever Cloud using token
async function loginCleverCloud() {
    console.log('[CLI] Logging into Clever Cloud with token...');
    try {
        const token = ENV.CLEVER_TOKEN;
        if (!token) {
            console.error('[CLI] No CLEVER_TOKEN found in environment');
            return false;
        }
        
        execSync(`clever login --token "${token}"`, { stdio: 'inherit' });
        console.log('[CLI] ✅ Logged into Clever Cloud successfully');
        return true;
    } catch (error) {
        console.error('[CLI] Token login failed:', error.message);
        return false;
    }
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

function installScalingoCLI() {
    if (!ENV.CLI_RESTART_ENABLED) {
        return false;
    }
    
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
        
        execSync('curl -L -o /tmp/scalingo.tar.gz https://github.com/Scalingo/cli/releases/download/1.44.1/scalingo_1.44.1_linux_amd64.tar.gz', { stdio: 'inherit' });
        execSync('cd /tmp && tar -xzf scalingo.tar.gz', { stdio: 'inherit' });
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

// ============ CENTRAL API ENDPOINTS (Only on central server) ============
function setupCentralEndpoints() {
    console.log('[Central] Setting up API endpoints...');
    
    const validateApiKey = (req, res, next) => {
        const key = req.headers['x-api-key'];
        if (key !== ENV.CENTRAL_API_KEY) {
            return res.status(401).json({ error: 'Invalid API key' });
        }
        next();
    };
    
    app.post('/api/register-bot', validateApiKey, async (req, res) => {
        try {
            const { deploymentId, deploymentName, region, startTime, version } = req.body;
            
            // UPSERT - update if exists, insert if not (prevents duplicates)
            await db.collection('deployments').updateOne(
                { deploymentId: deploymentId },
                { 
                    $set: {
                        deploymentId: deploymentId,
                        deploymentName: deploymentName,
                        region: region,
                        version: version,
                        status: 'active',
                        startTime: new Date(startTime),
                        lastHeartbeat: new Date(),
                        updatedAt: new Date()
                    },
                    $setOnInsert: {
                        createdAt: new Date(),
                        totalAccounts: 0
                    }
                },
                { upsert: true }
            );
            
            res.json({ success: true, message: 'Bot registered' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    app.post('/api/heartbeat', validateApiKey, async (req, res) => {
        try {
            const { deploymentId, deploymentName, region, status, accountsCreated, lastAccount } = req.body;
            
            await db.collection('deployments').updateOne(
                { deploymentId: deploymentId },
                { 
                    $set: {
                        deploymentName: deploymentName,
                        region: region,
                        status: status,
                        accountsCreated: accountsCreated,
                        lastAccount: lastAccount,
                        lastHeartbeat: new Date()
                    }
                }
            );
            
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    app.post('/api/metrics/add', validateApiKey, async (req, res) => {
        try {
            const { deploymentId, deploymentName, email, password, deployedApps, createdAt, restartCount } = req.body;
            
            await db.collection('accounts').insertOne({
                deploymentId: deploymentId,
                deploymentName: deploymentName,
                email: email,
                password: password,
                deployedApps: deployedApps,
                createdAt: new Date(createdAt),
                restartCount: restartCount
            });
            
            await db.collection('deployments').updateOne(
                { deploymentId: deploymentId },
                { 
                    $inc: { totalAccounts: 1 },
                    $set: { lastAccount: email, lastAccountTime: new Date() }
                }
            );
            
            res.json({ success: true, message: 'Metrics recorded' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    app.get('/api/connected-bots', async (req, res) => {
        try {
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const bots = await db.collection('deployments')
                .find({ lastHeartbeat: { $gt: fiveMinutesAgo } })
                .sort({ lastHeartbeat: -1 })
                .toArray();
            
            // Remove duplicates by deploymentId
            const uniqueBots = [];
            const seenIds = new Set();
            for (const bot of bots) {
                if (!seenIds.has(bot.deploymentId)) {
                    seenIds.add(bot.deploymentId);
                    uniqueBots.push(bot);
                }
            }
            
            res.json(uniqueBots);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    app.get('/api/all-accounts', async (req, res) => {
        try {
            const accounts = await db.collection('accounts').find({}).sort({ createdAt: -1 }).limit(100).toArray();
            res.json(accounts);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    app.get('/api/aggregated-metrics', async (req, res) => {
        try {
            const totalAccounts = await db.collection('accounts').countDocuments();
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const totalDeployments = await db.collection('deployments').countDocuments({ lastHeartbeat: { $gt: fiveMinutesAgo } });
            const activeDeployments = totalDeployments;
            const accountsByBot = await db.collection('accounts').aggregate([
                { $group: { _id: '$deploymentId', count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ]).toArray();
            
            res.json({ totalAccounts, totalDeployments, activeDeployments, accountsByBot, timestamp: new Date() });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    console.log('[Central] ✅ API endpoints ready');
}

// ============ BOT FUNCTIONS ============
async function sendHeartbeat() {
    const apiUrl = `${ENV.CENTRAL_API_URL}/api/heartbeat`;
    
    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': ENV.CENTRAL_API_KEY
            },
            body: JSON.stringify({
                deploymentId: ENV.DEPLOYMENT_ID,
                deploymentName: ENV.DEPLOYMENT_NAME,
                region: ENV.DEPLOYMENT_REGION,
                status: botStatus.state,
                accountsCreated: botStatus.totalAccounts,
                lastAccount: botStatus.accountEmail,
                timestamp: new Date()
            })
        });
        
        if (response.ok) console.log('[Heartbeat] ✅ Sent');
    } catch (error) {
        console.log('[Heartbeat] ❌ Failed:', error.message);
    }
}

async function sendMetricsToCentral(accountData) {
    const apiUrl = `${ENV.CENTRAL_API_URL}/api/metrics/add`;
    
    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': ENV.CENTRAL_API_KEY
            },
            body: JSON.stringify({
                deploymentId: ENV.DEPLOYMENT_ID,
                deploymentName: ENV.DEPLOYMENT_NAME,
                email: accountData.email,
                password: accountData.password,
                deployedApps: accountData.deployedApps || [],
                createdAt: accountData.createdAt,
                restartCount: botStatus.totalAccounts
            })
        });
        
        if (response.ok) log('CENTRAL', `✅ Metrics sent for ${accountData.email}`, 'success');
    } catch (error) {
        log('CENTRAL', `❌ Failed: ${error.message}`, 'error');
    }
}

async function registerWithCentral() {
    const apiUrl = `${ENV.CENTRAL_API_URL}/api/register-bot`;
    
    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': ENV.CENTRAL_API_KEY
            },
            body: JSON.stringify({
                deploymentId: ENV.DEPLOYMENT_ID,
                deploymentName: ENV.DEPLOYMENT_NAME,
                region: ENV.DEPLOYMENT_REGION,
                startTime: botStatus.startTime,
                version: '1.0.0'
            })
        });
        
        if (response.ok) log('CENTRAL', '✅ Registered with central server', 'success');
    } catch (error) {
        log('CENTRAL', `⚠️ Registration failed: ${error.message}`, 'warn');
    }
}

function startHeartbeat() {
    setInterval(async () => await sendHeartbeat(), 30000);
}

// ============ BOT CLASS ============
class CleverCloudBot {
    constructor(instanceId) {
        this.instanceId = instanceId;
        this.browser = null;
        this.page = null;
        this.mailPage = null;
        this.realTempEmail = null;
        this.chromePath = null;
    }

    async initBrowser() {
        await installChromeDependencies();
        
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
        
        await this.page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(x => x.innerText.toLowerCase().includes('sign up'));
            if (btn) btn.click();
        });
        
        await sleep(8000);
        log('SIGNUP', 'Form submitted', 'success', this.instanceId);
    }

    async getVerificationLink() {
        log('VERIFY', 'Waiting for verification email...', 'info', this.instanceId);
        const startTime = Date.now();
        let emailFound = false;
        
        while (Date.now() - startTime < 180000) {
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
            
            await sleep(5000);
        }
        throw new Error('No verification email received');
    }

    async startDockerInBackground(email, password) {
        return new Promise(async (resolve) => {
            log('DOCKER', 'Starting Docker deployment...', 'info', this.instanceId);
            
            await installCleverCLI();
            
            if (ENV.CLEVER_TOKEN) {
                const loggedIn = await loginCleverCloud();
                if (!loggedIn) {
                    log('DOCKER', 'Token login failed, deployment may fail', 'warn', this.instanceId);
                }
            } else {
                log('DOCKER', 'No CLEVER_TOKEN set, deployment will fail', 'error', this.instanceId);
                resolve({ success: false, email, deployedApps: [] });
                return;
            }
            
            const dockerScriptPath = '/app/docker';
            
            if (!fs.existsSync(dockerScriptPath)) {
                log('DOCKER', 'Docker script not found, skipping deployment', 'warn', this.instanceId);
                resolve({ success: true, email, deployedApps: [] });
                return;
            }
            
            const dockerProcess = spawn('bash', [dockerScriptPath], { 
                detached: true, 
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { 
                    ...process.env, 
                    CLEVER_TOKEN: ENV.CLEVER_TOKEN,
                    EMAIL: email,
                    PASSWORD: password
                }
            });
            
            let deployedApps = [];
            let outputBuffer = '';
            
            dockerProcess.stdout.on('data', (data) => {
                const output = data.toString();
                outputBuffer += output;
                console.log(`[DOCKER] ${output.trim()}`);
                
                const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.osc-fr1\.scalingo\.io/);
                if (urlMatch && !deployedApps.includes(urlMatch[0])) {
                    deployedApps.push(urlMatch[0]);
                    log('DOCKER', `App deployed: ${urlMatch[0]}`, 'success', this.instanceId);
                }
                
                if (output.includes('All 3 apps deployed') || output.includes('successfully deployed')) {
                    log('DOCKER', 'Deployment completed!', 'success', this.instanceId);
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
                } else if (code === 0 || outputBuffer.includes('success')) {
                    resolve({ success: true, email, deployedApps: [] });
                } else {
                    resolve({ success: false, email, deployedApps: [] });
                }
            });
            
            setTimeout(() => {
                if (deployedApps.length > 0) {
                    resolve({ success: true, email, deployedApps });
                } else {
                    resolve({ success: true, email, deployedApps: [] });
                }
            }, 300000);
        });
    }

    async cleanup() {
        if (this.browser) await this.browser.close();
    }

    async createSingleAccount() {
        let browserInitialized = false;
        
        try {
            await this.initBrowser();
            browserInitialized = true;
            
            const accountEmail = await this.fetchTempEmail();
            botStatus.accountEmail = accountEmail;
            
            const dynamicPassword = accountEmail;
            
            await this.handleSignup(accountEmail, dynamicPassword);
            const verifyLink = await this.getVerificationLink();
            
            log('VERIFY', 'Activating account...', 'info', this.instanceId);
            await this.page.goto(verifyLink, { waitUntil: 'domcontentloaded' });
            await sleep(5000);
            
            const result = await this.startDockerInBackground(accountEmail, dynamicPassword);
            
            if (db) {
                await db.collection('accounts').insertOne({
                    deploymentId: ENV.DEPLOYMENT_ID,
                    deploymentName: ENV.DEPLOYMENT_NAME,
                    email: accountEmail,
                    password: dynamicPassword,
                    deployedApps: result.deployedApps || [],
                    createdAt: new Date(),
                    instanceId: this.instanceId
                });
            }
            
            await sendMetricsToCentral({
                email: accountEmail,
                password: dynamicPassword,
                deployedApps: result.deployedApps || [],
                createdAt: new Date()
            });
            
            botStatus.totalAccounts++;
            
            log('SUCCESS', `✓ Account #${botStatus.totalAccounts}: ${accountEmail} created! Password = ${dynamicPassword}`, 'success', this.instanceId);
            
            await this.cleanup();
            return true;
            
        } catch (error) {
            log('ERROR', `${error.message}`, 'error', this.instanceId);
            if (browserInitialized) {
                await this.cleanup();
            }
            return false;
        }
    }

    async runLoop() {
        log('START', '=== BOT STARTING ===', 'info', this.instanceId);
        log('START', `Mode: ${ENV.CLI_RESTART_ENABLED ? 'Central Server (restart after each account)' : 'Worker (continuous creation)'}`, 'info', this.instanceId);
        
        if (!ENV.CLEVER_TOKEN) {
            log('START', '⚠️ WARNING: CLEVER_TOKEN not set! Deployment will fail!', 'error', this.instanceId);
        }
        
        if (ENV.CLI_RESTART_ENABLED) {
            while (true) {
                const success = await this.createSingleAccount();
                if (success) {
                    log('RESTART', 'Account created, restarting for new IP...', 'info', this.instanceId);
                } else {
                    log('RESTART', 'Account creation failed, restarting to retry...', 'warn', this.instanceId);
                }
                await sleep(2000);
                process.exit(0);
            }
        } else {
            while (true) {
                try {
                    log('LOOP', `Starting account #${botStatus.totalAccounts + 1}...`, 'info', this.instanceId);
                    const success = await this.createSingleAccount();
                    
                    if (success) {
                        log('LOOP', 'Account created. Waiting 15 seconds...', 'info', this.instanceId);
                        await sleep(15000);
                    } else {
                        log('LOOP', 'Creation failed. Waiting 30 seconds...', 'warn', this.instanceId);
                        await sleep(30000);
                    }
                } catch (error) {
                    log('LOOP', `Error: ${error.message}`, 'error', this.instanceId);
                    await sleep(30000);
                }
            }
        }
    }
}

// ============ DASHBOARD (Only on central server) ============
if (ENV.IS_CENTRAL) {
    app.get('/', async (req, res) => {
        try {
            await cleanupStaleDeployments();
            
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const bots = await db.collection('deployments')
                .find({ lastHeartbeat: { $gt: fiveMinutesAgo } })
                .sort({ lastHeartbeat: -1 })
                .toArray();
            
            // Remove duplicates by deploymentId - keep only the most recent for each ID
            const uniqueBotsMap = new Map();
            for (const bot of bots) {
                const existing = uniqueBotsMap.get(bot.deploymentId);
                if (!existing || bot.lastHeartbeat > existing.lastHeartbeat) {
                    uniqueBotsMap.set(bot.deploymentId, bot);
                }
            }
            const uniqueBots = Array.from(uniqueBotsMap.values());
            
            const totalAccounts = await db.collection('accounts').countDocuments();
            const activeBots = uniqueBots.length;
            
            let botsHtml = '';
            if (uniqueBots.length === 0) {
                botsHtml = '<div class="bot-card" style="text-align:center; grid-column:1/-1;"><p>🤖 No active bots connected yet. Bot workers will appear here when they start.</p></div>';
            } else {
                for (const bot of uniqueBots) {
                    const botId = bot.deploymentId || 'unknown';
                    const botName = bot.deploymentName || botId;
                    const botAccounts = bot.totalAccounts || 0;
                    const botLastAccount = bot.lastAccount || 'None';
                    const botLastSeen = bot.lastHeartbeat ? new Date(bot.lastHeartbeat).toLocaleString() : 'Never';
                    
                    botsHtml += `
                        <div class="bot-card">
                            <div>
                                <span class="bot-status status-active"></span>
                                <strong class="bot-name">${escapeHtml(botName)}</strong>
                                ${bot.deploymentId === ENV.DEPLOYMENT_ID ? '<span style="background:#667eea; color:white; padding:2px 8px; border-radius:12px; font-size:10px; margin-left:8px;">THIS SERVER</span>' : ''}
                            </div>
                            <div class="bot-detail">🆔 ID: ${escapeHtml(botId.length > 30 ? botId.substring(0, 30) + '...' : botId)}</div>
                            <div class="bot-detail">📊 Accounts: ${botAccounts}</div>
                            <div class="bot-detail">📧 Last: ${escapeHtml(botLastAccount)}</div>
                            <div class="bot-detail">⏱️ Last seen: ${botLastSeen}</div>
                        </div>
                    `;
                }
            }
            
            const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Central Bot Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: 'Inter', sans-serif;
            padding: 40px 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 40px; }
        .header h1 { color: white; font-size: 2.5rem; margin-bottom: 10px; }
        .header p { color: rgba(255,255,255,0.9); }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .stat-card { background: white; border-radius: 15px; padding: 25px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
        .stat-value { font-size: 2.5rem; font-weight: bold; color: #667eea; }
        .stat-label { color: #666; margin-top: 5px; }
        .bots-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .bot-card { background: white; border-radius: 15px; padding: 20px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
        .bot-status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; background: #10b981; box-shadow: 0 0 5px #10b981; }
        .bot-name { font-weight: 600; font-size: 1.1rem; margin-bottom: 10px; }
        .bot-detail { color: #666; font-size: 0.9rem; margin: 5px 0; }
        .accounts-table { background: white; border-radius: 15px; padding: 20px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; font-weight: 600; }
        .refresh-btn { background: #667eea; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; margin-bottom: 20px; }
        .refresh-btn:hover { background: #5a67d8; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Central Bot Command Center</h1>
            <p>Monitoring ${uniqueBots.length} active bot deployments • ${totalAccounts} total accounts created</p>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-value">${totalAccounts}</div><div class="stat-label">Total Accounts</div></div>
            <div class="stat-card"><div class="stat-value">${uniqueBots.length}</div><div class="stat-label">Active Bots</div></div>
            <div class="stat-card"><div class="stat-value">${activeBots}</div><div class="stat-label">Online Now</div></div>
            <div class="stat-card"><div class="stat-value">👑</div><div class="stat-label">Central Server</div></div>
        </div>
        
        <h2 style="color: white; margin-bottom: 20px;">📡 Connected Bot Deployments (Active Only)</h2>
        <div class="bots-grid">
            ${botsHtml}
        </div>
        
        <h2 style="color: white; margin-bottom: 20px;">📝 Recent Accounts (All Bots)</h2>
        <div class="accounts-table">
            <button class="refresh-btn" onclick="location.reload()">🔄 Refresh Dashboard</button>
            <table id="accountsTable">
                <thead><tr><th>Bot</th><th>Email</th><th>Password</th><th>Apps</th><th>Created</th></tr></thead>
                <tbody id="accountsBody"><tr><td colspan="5">Loading...</td></tr>
                </tbody>
            </table>
        </div>
    </div>
    <script>
        function escapeHtml(text) {
            if (!text) return '';
            return String(text).replace(/[&<>]/g, function(m) {
                if (m === '&') return '&amp;';
                if (m === '<') return '&lt;';
                if (m === '>') return '&gt;';
                return m;
            });
        }
        
        async function loadAccounts() {
            try {
                const res = await fetch('/api/all-accounts');
                const accounts = await res.json();
                const tbody = document.getElementById('accountsBody');
                if(!accounts || accounts.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5">No accounts yet</td></tr>';
                    return;
                }
                let html = '';
                for(let acc of accounts.slice(0, 50)) {
                    html += '<tr>' +
                        '<td>' + escapeHtml(acc.deploymentName || (acc.deploymentId ? acc.deploymentId.substring(0, 15) : 'Unknown')) + '</td>' +
                        '<td>' + escapeHtml(acc.email) + '</td>' +
                        '<td><code>' + escapeHtml(acc.password) + '</code></td>' +
                        '<td>' + (acc.deployedApps ? acc.deployedApps.length : 0) + '</td>' +
                        '<td>' + new Date(acc.createdAt).toLocaleString() + '</td>' +
                    '</tr>';
                }
                tbody.innerHTML = html;
            } catch(e) {
                console.error(e);
                document.getElementById('accountsBody').innerHTML = '<tr><td colspan="5">Error loading accounts</td></tr>';
            }
        }
        
        loadAccounts();
        setInterval(loadAccounts, 10000);
        setInterval(function() { location.reload(); }, 30000);
    </script>
</body>
</html>`;
            
            res.send(html);
        } catch (error) {
            console.error('Dashboard error:', error);
            res.status(500).send('Dashboard error: ' + error.message);
        }
    });
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text).replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// ============ START APPLICATION ============
async function main() {
    console.log(`\n🚀 Starting application...`);
    
    if (ENV.IS_CENTRAL) {
        console.log(`📊 Dashboard: http://localhost:${port}`);
        console.log(`🎯 Mode: CENTRAL SERVER (Dashboard + Bot Worker)`);
        console.log(`   - Web server: ENABLED (port ${port})`);
        console.log(`   - Account creation: ENABLED`);
        console.log(`   - CLI Restart: ${ENV.CLI_RESTART_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    } else {
        console.log(`🎯 Mode: BOT WORKER (Account Creator Only - No Web Server)`);
        console.log(`   - Web server: DISABLED`);
        console.log(`   - Account creation: ENABLED`);
        console.log(`   - Running continuously: YES`);
        console.log(`   - Persistent ID: ${ENV.DEPLOYMENT_ID}`);
    }
    console.log('');
    
    await connectMongoDB();
    
    // Clean up duplicates on startup
    await cleanupDuplicateDeployments();
    
    // ONLY setup API endpoints and start web server on CENTRAL server
    if (ENV.IS_CENTRAL) {
        setupCentralEndpoints();
        app.listen(port, '0.0.0.0', () => {
            console.log(`✅ Central dashboard running on port ${port}`);
        });
    } else {
        console.log(`✅ Bot worker started - no web server (pure account creation mode)`);
    }
    
    // Register with central (workers register, central registers itself)
    await registerWithCentral();
    
    // Start heartbeat for both central and workers
    startHeartbeat();
    
    // Small delay to ensure everything is ready
    await sleep(2000);
    
    // Start the bot loop for BOTH central and workers
    const bot = new CleverCloudBot(ENV.DEPLOYMENT_ID);
    await bot.runLoop();
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
