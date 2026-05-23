// single-bot-system.js - DEPLOY THIS EXACT SAME FILE EVERYWHERE
// The code automatically knows if it's the central server based on the domain
// Central server domain: business-app.osc-fr1.scalingo.io
// Bot workers: any other domain

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

// ============ AUTO-DETECT CENTRAL MODE BASED ON DOMAIN ============
const CENTRAL_DOMAIN = 'business-app.osc-fr1.scalingo.io'; // Your central server domain
const CURRENT_HOSTNAME = os.hostname();
const IS_CENTRAL_SERVER = CURRENT_HOSTNAME.includes('business-app') || 
                           process.env.IS_CENTRAL === 'true' || // Fallback manual override
                           (process.env.DOMAIN && process.env.DOMAIN.includes('business-app'));

console.log('\n========================================');
console.log('  BOT SYSTEM DEPLOYMENT');
console.log('========================================');
console.log(`Current Hostname: ${CURRENT_HOSTNAME}`);
console.log(`Central Domain: ${CENTRAL_DOMAIN}`);
console.log(`Mode: ${IS_CENTRAL_SERVER ? '🔵 CENTRAL SERVER (Dashboard & API)' : '🟢 BOT WORKER (Account Creator)'}`);
console.log('========================================\n');

// ============ ENVIRONMENT VARIABLES ============
const ENV = {
    // Auto-detected mode
    IS_CENTRAL: IS_CENTRAL_SERVER,
    
    // Core settings
    BOT_PASSWORD: process.env.BOT_PASSWORD || 'Linuxdistro&84',
    BOT_START_DELAY: parseInt(process.env.BOT_START_DELAY) || 10,
    HEADLESS_MODE: process.env.HEADLESS_MODE !== 'false',
    CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/app/chrome-linux64/chrome',
    CLEVER_TOKEN: process.env.CLEVER_TOKEN || '',
    SCALINGO_API_TOKEN: process.env.SCALINGO_API_TOKEN || '',
    SCALINGO_APP_NAME: process.env.SCALINGO_APP_NAME || '',
    
    // Deployment identification (same for both modes)
    DEPLOYMENT_ID: process.env.DEPLOYMENT_ID || `bot-${CURRENT_HOSTNAME}-${Date.now()}`,
    DEPLOYMENT_NAME: process.env.DEPLOYMENT_NAME || CURRENT_HOSTNAME,
    DEPLOYMENT_REGION: process.env.DEPLOYMENT_REGION || 'osc-fr1',
    
    // Central server connection (bots will use this, central will ignore)
    CENTRAL_API_URL: process.env.CENTRAL_API_URL || `https://${CENTRAL_DOMAIN}`,
    CENTRAL_API_KEY: process.env.CENTRAL_API_KEY || 'change-this-secret-key-12345',
    
    // MongoDB connection string
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888'
};

// ============ MONGODB CONNECTION ============
let dbClient = null;
let db = null;

async function connectMongoDB() {
    try {
        dbClient = new MongoClient(ENV.MONGODB_URI);
        await dbClient.connect();
        db = dbClient.db('botdb');
        console.log('[MongoDB] Connected successfully');
        
        // Create collections
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
    state: 'starting',
    accountCreated: false,
    accountEmail: null,
    startTime: new Date(),
    completionTime: null,
    restartCount: 0,
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
    if (ENV.IS_CENTRAL) return true; // Central doesn't need CLI
    
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

// ============ CENTRAL API ENDPOINTS (Only active on central server) ============
function setupCentralEndpoints() {
    if (!ENV.IS_CENTRAL) return;
    
    console.log('[Central] Setting up API endpoints...');
    
    // API Key validation middleware
    const validateApiKey = (req, res, next) => {
        const key = req.headers['x-api-key'];
        if (key !== ENV.CENTRAL_API_KEY) {
            return res.status(401).json({ error: 'Invalid API key' });
        }
        next();
    };
    
    // Register a bot deployment
    app.post('/api/register-bot', validateApiKey, async (req, res) => {
        try {
            const { deploymentId, deploymentName, region, startTime, version } = req.body;
            
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
                        registeredAt: new Date()
                    }
                },
                { upsert: true }
            );
            
            res.json({ success: true, message: 'Bot registered' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // Receive heartbeat from bots
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
    
    // Receive metrics from bots
    app.post('/api/metrics/add', validateApiKey, async (req, res) => {
        try {
            const { deploymentId, deploymentName, email, password, deployedApps, createdAt, restartCount } = req.body;
            
            // Store account
            await db.collection('accounts').insertOne({
                deploymentId: deploymentId,
                deploymentName: deploymentName,
                email: email,
                password: password,
                deployedApps: deployedApps,
                createdAt: new Date(createdAt),
                restartCount: restartCount
            });
            
            // Update deployment stats
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
    
    // Get all connected bots
    app.get('/api/connected-bots', async (req, res) => {
        try {
            const bots = await db.collection('deployments')
                .find({})
                .sort({ lastHeartbeat: -1 })
                .toArray();
            
            // Calculate active status (heartbeat within last 5 minutes)
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const botsWithStatus = bots.map(bot => ({
                ...bot,
                isActive: bot.lastHeartbeat > fiveMinutesAgo,
                isCentral: bot.deploymentId === ENV.DEPLOYMENT_ID
            }));
            
            res.json(botsWithStatus);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // Get all accounts from all bots
    app.get('/api/all-accounts', async (req, res) => {
        try {
            const accounts = await db.collection('accounts')
                .find({})
                .sort({ createdAt: -1 })
                .limit(100)
                .toArray();
            res.json(accounts);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // Get aggregated metrics
    app.get('/api/aggregated-metrics', async (req, res) => {
        try {
            const totalAccounts = await db.collection('accounts').countDocuments();
            const totalDeployments = await db.collection('deployments').countDocuments();
            const activeDeployments = await db.collection('deployments')
                .countDocuments({ lastHeartbeat: { $gt: new Date(Date.now() - 5 * 60 * 1000) } });
            
            const accountsByBot = await db.collection('accounts')
                .aggregate([
                    { $group: { _id: '$deploymentId', count: { $sum: 1 } } },
                    { $sort: { count: -1 } }
                ]).toArray();
            
            res.json({
                totalAccounts,
                totalDeployments,
                activeDeployments,
                accountsByBot,
                timestamp: new Date()
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    console.log('[Central] ✅ API endpoints ready');
}

// ============ BOT FUNCTIONS (Only active on bot workers) ============
async function sendHeartbeat() {
    if (ENV.IS_CENTRAL) return;
    
    try {
        const response = await fetch(`${ENV.CENTRAL_API_URL}/api/heartbeat`, {
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
                accountsCreated: botStatus.restartCount,
                lastAccount: botStatus.accountEmail,
                timestamp: new Date()
            })
        });
        
        if (response.ok) {
            console.log('[Heartbeat] ✅ Sent to central server');
        }
    } catch (error) {
        console.log('[Heartbeat] ❌ Failed:', error.message);
    }
}

async function sendMetricsToCentral(accountData) {
    if (ENV.IS_CENTRAL) return;
    
    try {
        const response = await fetch(`${ENV.CENTRAL_API_URL}/api/metrics/add`, {
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
                restartCount: botStatus.restartCount
            })
        });
        
        if (response.ok) {
            log('CENTRAL', `✅ Metrics sent for ${accountData.email}`, 'success');
        }
    } catch (error) {
        log('CENTRAL', `❌ Failed: ${error.message}`, 'error');
    }
}

async function registerWithCentral() {
    if (ENV.IS_CENTRAL) return;
    
    try {
        const response = await fetch(`${ENV.CENTRAL_API_URL}/api/register-bot`, {
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
        
        if (response.ok) {
            log('CENTRAL', '✅ Registered with central server', 'success');
        }
    } catch (error) {
        log('CENTRAL', `⚠️ Registration failed: ${error.message}`, 'warn');
    }
}

// Start heartbeat interval (bots only)
function startHeartbeat() {
    if (ENV.IS_CENTRAL) return;
    
    setInterval(async () => {
        await sendHeartbeat();
    }, 30000); // Send every 30 seconds
}

// ============ RESTART VIA CLI ============
async function restartWithCLI() {
    if (ENV.IS_CENTRAL) return false;
    
    const cliPath = '/app/bin/scalingo';
    const appName = ENV.SCALINGO_APP_NAME;
    const apiToken = ENV.SCALINGO_API_TOKEN;
    
    if (!fs.existsSync(cliPath) || !appName || !apiToken) {
        log('RESTART', 'CLI not configured', 'warn', 'MAIN');
        return false;
    }
    
    log('RESTART', `Restarting ${appName} via CLI...`, 'info', 'MAIN');
    
    return new Promise((resolve) => {
        const cmd = `${cliPath} login --api-token "${apiToken}" && ${cliPath} --app ${appName} restart`;
        const child = spawn('bash', ['-c', cmd]);
        
        child.stdout.on('data', (data) => console.log(`[CLI] ${data.toString().trim()}`));
        child.stderr.on('data', (data) => console.log(`[CLI ERR] ${data.toString().trim()}`));
        
        child.on('close', (code) => {
            if (code === 0) {
                log('RESTART', '✅ Restart initiated!', 'success', 'MAIN');
                resolve(true);
            } else {
                log('RESTART', `Failed with code ${code}`, 'error', 'MAIN');
                resolve(false);
            }
        });
    });
}

// ============ BOT CLASS ============
class CleverCloudBot {
    constructor(instanceId, startDelay = 0) {
        this.instanceId = instanceId;
        this.browser = null;
        this.page = null;
        this.mailPage = null;
        this.realTempEmail = null;
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

    async handleOAuth(url, email, password) {
        log('OAUTH', 'Auto-login in progress...', 'info', this.instanceId);
        try {
            const oauthPage = await this.browser.newPage();
            await oauthPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            await sleep(3000);
            
            await oauthPage.evaluate((email, password) => {
                const emailField = document.querySelector('input[type="email"], input[name="email"]');
                const passwordField = document.querySelector('input[type="password"], input[name="password"]');
                if (emailField && passwordField) {
                    emailField.value = email;
                    passwordField.value = password;
                    emailField.dispatchEvent(new Event('input', { bubbles: true }));
                    passwordField.dispatchEvent(new Event('input', { bubbles: true }));
                    const btn = Array.from(document.querySelectorAll('button')).find(b => 
                        (b.innerText || '').toLowerCase().includes('login'));
                    if (btn) btn.click();
                    return true;
                }
                return false;
            }, email, password);
            
            await sleep(8000);
            await oauthPage.close();
            log('OAUTH', 'Completed', 'success', this.instanceId);
            return true;
        } catch (error) {
            log('OAUTH', `Error: ${error.message}`, 'error', this.instanceId);
            return false;
        }
    }

    async startDockerInBackground(email, password) {
        return new Promise((resolve, reject) => {
            log('DOCKER', 'Starting Docker deployment...', 'info', this.instanceId);
            const dockerScriptPath = '/app/docker';
            
            if (!fs.existsSync(dockerScriptPath)) {
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
            
            dockerProcess.stdout.on('data', async (data) => {
                const output = data.toString();
                console.log(`[DOCKER] ${output.trim()}`);
                
                if (!oauthUrlDetected && !this.oauthHandled) {
                    const oauthMatch = output.match(/https:\/\/console\.clever-cloud\.com\/cli-oauth\?[^\s]+/);
                    if (oauthMatch) {
                        oauthUrlDetected = true;
                        this.oauthHandled = true;
                        await this.handleOAuth(oauthMatch[0], email, password);
                    }
                }
                
                const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.osc-fr1\.scalingo\.io/);
                if (urlMatch && !deployedApps.includes(urlMatch[0])) {
                    deployedApps.push(urlMatch[0]);
                    log('DOCKER', `App deployed: ${urlMatch[0]}`, 'success', this.instanceId);
                }
                
                if (output.includes('All 3 apps deployed')) {
                    resolve({ success: true, email, deployedApps });
                }
            });
            
            dockerProcess.on('close', (code) => {
                if (deployedApps.length > 0) resolve({ success: true, email, deployedApps });
                else if (code === 0) resolve({ success: true, email, deployedApps: [] });
                else reject(new Error(`Docker exited with code ${code}`));
            });
            
            setTimeout(() => {
                if (deployedApps.length > 0) resolve({ success: true, email, deployedApps });
                else reject(new Error('Deployment timeout'));
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
        
        if (ENV.IS_CENTRAL) {
            log('START', 'Central server mode - no account creation', 'info', this.instanceId);
            return;
        }
        
        log('START', '=== CREATING ONE ACCOUNT ===', 'info', this.instanceId);
        botStatus.state = 'running';
        
        let accountCreated = false;
        let accountEmail = null;
        
        try {
            await this.initBrowser();
            
            accountEmail = await this.fetchTempEmail();
            botStatus.accountEmail = accountEmail;
            
            const dynamicPassword = accountEmail;
            
            await this.handleSignup(accountEmail, dynamicPassword);
            const verifyLink = await this.getVerificationLink();
            
            log('VERIFY', 'Activating account...', 'info', this.instanceId);
            await this.page.goto(verifyLink, { waitUntil: 'domcontentloaded' });
            await sleep(5000);
            
            const result = await this.startDockerInBackground(accountEmail, dynamicPassword);
            
            // Store in MongoDB
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
            
            // Send to central server
            await sendMetricsToCentral({
                email: accountEmail,
                password: dynamicPassword,
                deployedApps: result.deployedApps || [],
                createdAt: new Date()
            });
            
            accountCreated = true;
            botStatus.accountCreated = true;
            
            log('SUCCESS', `✓ Account ${accountEmail} created! Password = ${dynamicPassword}`, 'success', this.instanceId);
            
        } catch (error) {
            log('ERROR', `${error.message}`, 'error', this.instanceId);
            log('FAILURE', 'Account creation failed - will restart to retry', 'warn', this.instanceId);
        }
        
        await this.cleanup();
        
        botStatus.completionTime = new Date();
        botStatus.state = accountCreated ? 'completed' : 'failed';
        botStatus.restartCount++;
        
        log('RESTART', `========================================`, 'info', this.instanceId);
        log('RESTART', `${accountCreated ? 'Account created' : 'Account creation failed'} - Restarting for NEW IP`, 'info', this.instanceId);
        log('RESTART', `This was attempt #${botStatus.restartCount}`, 'info', this.instanceId);
        log('RESTART', `========================================`, 'info', this.instanceId);
        
        const cliSuccess = await restartWithCLI();
        
        if (!cliSuccess) {
            log('RESTART', 'CLI restart failed, using exit restart', 'warn', 'MAIN');
        }
        
        await sleep(2000);
        process.exit(0);
    }
}

// ============ DASHBOARD (Works for both modes) ============
app.get('/', async (req, res) => {
    if (ENV.IS_CENTRAL) {
        // Central server dashboard showing all bots
        const bots = await db.collection('deployments').find({}).toArray();
        const totalAccounts = await db.collection('accounts').countDocuments();
        const activeBots = bots.filter(b => b.lastHeartbeat > new Date(Date.now() - 5 * 60 * 1000)).length;
        
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Central Bot Dashboard • All Deployments</title>
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
        .bot-status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
        .status-active { background: #10b981; box-shadow: 0 0 5px #10b981; }
        .status-inactive { background: #ef4444; }
        .bot-name { font-weight: 600; font-size: 1.1rem; margin-bottom: 10px; }
        .bot-detail { color: #666; font-size: 0.9rem; margin: 5px 0; }
        .accounts-table { background: white; border-radius: 15px; padding: 20px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; font-weight: 600; }
        .refresh-btn { background: white; color: #667eea; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; margin-bottom: 20px; font-weight: 600; }
        .refresh-btn:hover { transform: translateY(-2px); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Central Bot Command Center</h1>
            <p>Monitoring ${bots.length} bot deployments • ${totalAccounts} total accounts created</p>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-value">${totalAccounts}</div><div class="stat-label">Total Accounts Created</div></div>
            <div class="stat-card"><div class="stat-value">${bots.length}</div><div class="stat-label">Connected Bots</div></div>
            <div class="stat-card"><div class="stat-value">${activeBots}</div><div class="stat-label">Active Bots</div></div>
            <div class="stat-card"><div class="stat-value">${ENV.DEPLOYMENT_ID === 'central' ? '👑' : '🔄'}</div><div class="stat-label">This is Central Server</div></div>
        </div>
        
        <h2 style="color: white; margin-bottom: 20px;">📡 Connected Bot Deployments</h2>
        <div class="bots-grid" id="botsGrid">
            ${bots.map(bot => `
                <div class="bot-card">
                    <div><span class="bot-status ${bot.lastHeartbeat > new Date(Date.now() - 5*60*1000) ? 'status-active' : 'status-inactive'}"></span>
                    <strong class="bot-name">${bot.deploymentName || bot.deploymentId}</strong></div>
                    <div class="bot-detail">🆔 ID: ${bot.deploymentId.substring(0, 20)}...</div>
                    <div class="bot-detail">📊 Accounts: ${bot.totalAccounts || 0}</div>
                    <div class="bot-detail">📧 Last: ${bot.lastAccount || 'None'}</div>
                    <div class="bot-detail">⏱️ Last seen: ${bot.lastHeartbeat ? new Date(bot.lastHeartbeat).toLocaleString() : 'Never'}</div>
                </div>
            `).join('')}
        </div>
        
        <h2 style="color: white; margin-bottom: 20px;">📝 Recent Accounts (All Bots)</h2>
        <div class="accounts-table">
            <table id="accountsTable">
                <thead><tr><th>Bot</th><th>Email</th><th>Password</th><th>Deployed Apps</th><th>Created At</th></tr></thead>
                <tbody id="accountsBody"><tr><td colspan="5">Loading...</td></tr></tbody>
            </table>
        </div>
    </div>
    <script>
        async function loadAccounts() {
            const res = await fetch('/api/all-accounts');
            const accounts = await res.json();
            const tbody = document.getElementById('accountsBody');
            if(accounts.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5">No accounts yet</td></tr>';
                return;
            }
            tbody.innerHTML = accounts.slice(0, 50).map(acc => `
                <tr>
                    <td><strong>${acc.deploymentName || acc.deploymentId?.substring(0, 15)}</strong></td>
                    <td>${acc.email}</td>
                    <td><code>${acc.password}</code></td>
                    <td>${acc.deployedApps?.length || 0}</td>
                    <td>${new Date(acc.createdAt).toLocaleString()}</td>
                </tr>
            `).join('');
        }
        loadAccounts();
        setInterval(loadAccounts, 10000);
        setInterval(() => location.reload(), 30000);
    </script>
</body>
</html>`);
    } else {
        // Bot worker dashboard
        res.send(`<!DOCTYPE html>
<html>
<head>
    <title>Bot Worker • ${ENV.DEPLOYMENT_NAME}</title>
    <style>
        body { font-family: monospace; padding: 40px; background: #0a0e27; color: #00ff88; }
        .container { max-width: 800px; margin: 0 auto; }
        .status { background: #1a1f3a; padding: 20px; border-radius: 10px; margin: 20px 0; }
        .online { color: #00ff88; }
        h1 { color: #fff; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 Bot Worker: ${ENV.DEPLOYMENT_NAME}</h1>
        <div class="status">
            <p>📡 Status: <span class="online">● ONLINE</span></p>
            <p>🆔 ID: ${ENV.DEPLOYMENT_ID}</p>
            <p>🎯 Mode: Bot Worker (Creating Accounts)</p>
            <p>📊 Accounts Created: ${botStatus.restartCount}</p>
            <p>📧 Last Account: ${botStatus.accountEmail || 'None yet'}</p>
            <p>🔄 Connected to Central: ${ENV.CENTRAL_API_URL}</p>
        </div>
        <p>This bot is automatically creating accounts and reporting to the central dashboard.</p>
        <p>📊 View all bots at: <a href="${ENV.CENTRAL_API_URL}" style="color:#00ff88">${ENV.CENTRAL_API_URL}</a></p>
    </div>
</body>
</html>`);
    }
});

// ============ START APPLICATION ============
async function main() {
    console.log(`\n🚀 Starting application...`);
    console.log(`📊 Dashboard: http://localhost:${port}`);
    console.log(`🎯 Mode: ${ENV.IS_CENTRAL ? 'CENTRAL SERVER' : 'BOT WORKER'}\n`);
    
    await connectMongoDB();
    
    if (ENV.IS_CENTRAL) {
        setupCentralEndpoints();
        console.log('[Central] Server ready - waiting for bot connections...');
    } else {
        installScalingoCLI();
        await registerWithCentral();
        startHeartbeat();
        console.log('[Bot] Worker ready - starting account creation...');
    }
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`✅ Server running on port ${port}`);
    });
    
    if (!ENV.IS_CENTRAL) {
        await sleep(2000);
        const bot = new CleverCloudBot(ENV.DEPLOYMENT_ID, ENV.BOT_START_DELAY);
        await bot.run();
    }
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
