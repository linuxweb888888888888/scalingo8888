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

// ============ PERSISTENT DEPLOYMENT ID ============
const PERSISTENT_ID_FILE = '/app/.deployment_id';
let persistentDeploymentId = `bot-${CURRENT_HOSTNAME}-${Date.now()}`;

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
    BOT_START_DELAY: parseInt(process.env.BOT_START_DELAY) || 10,
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
console.log(`  Clever Token: ${ENV.CLEVER_TOKEN ? '✓ Configured' : '✗ Not configured'}`);
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

async function restartWithCLI() {
    if (!ENV.CLI_RESTART_ENABLED) return false;
    
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
                log('RESTART', '✅ CLI restart initiated!', 'success', 'MAIN');
                resolve(true);
            } else {
                log('RESTART', `CLI failed with code ${code}`, 'error', 'MAIN');
                resolve(false);
            }
        });
    });
}

async function logoutCleverCloud() {
    log('CLI', 'Logging out of Clever Cloud...', 'info', 'MAIN');
    try {
        execSync('clever logout', { stdio: 'inherit' });
        log('CLI', '✅ Logged out successfully', 'success', 'MAIN');
    } catch (error) {
        log('CLI', 'No active session to logout', 'info', 'MAIN');
    }
    
    try {
        const homeDir = process.env.HOME || '/app';
        const tokenFiles = [
            `${homeDir}/.config/clever-cloud/credentials.json`,
            `${homeDir}/.clever.json`,
            `/.clever.json`
        ];
        
        for (const tokenFile of tokenFiles) {
            if (fs.existsSync(tokenFile)) {
                fs.unlinkSync(tokenFile);
                log('CLI', `Removed ${tokenFile}`, 'info', 'MAIN');
            }
        }
    } catch (error) {
        // Ignore errors
    }
}

// ============ EMAILNATOR FUNCTIONS ============
async function generateEmailnatorEmail() {
    try {
        log('EMAIL', 'Generating temporary Gmail via Emailnator...', 'info', 'EMAIL');
        
        // Method 1: Use the generate-email endpoint
        const response = await fetch('https://www.emailnator.com/generate-email', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: JSON.stringify({ email: "gmail" })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        // Extract email from response
        let email = null;
        if (data.email) {
            email = data.email;
        } else if (data.emailList && data.emailList.length > 0) {
            email = data.emailList[0];
        } else if (data[0]) {
            email = data[0];
        }
        
        if (!email) {
            throw new Error('No email in response');
        }
        
        log('EMAIL', `Generated: ${email}`, 'success', 'EMAIL');
        return email;
        
    } catch (error) {
        log('EMAIL', `Generation failed: ${error.message}`, 'error', 'EMAIL');
        throw error;
    }
}

async function waitForEmailnatorMessage(email, timeoutSeconds = 180) {
    const startTime = Date.now();
    let lastMessageCount = 0;
    
    log('EMAIL', `Waiting for verification email to ${email}...`, 'info', 'EMAIL');
    
    while ((Date.now() - startTime) < timeoutSeconds * 1000) {
        try {
            // Poll for messages
            const response = await fetch('https://www.emailnator.com/message-list', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                body: JSON.stringify({ email: email })
            });
            
            if (!response.ok) {
                await sleep(5000);
                continue;
            }
            
            const data = await response.json();
            
            // Check for new messages
            if (data.messageList && data.messageList.length > 0) {
                const messages = data.messageList;
                
                if (messages.length > lastMessageCount) {
                    // New message found
                    const latestMessage = messages[messages.length - 1];
                    
                    // Check if it's from Clever Cloud
                    if (latestMessage.subject && 
                        (latestMessage.subject.toLowerCase().includes('clever') ||
                         latestMessage.subject.toLowerCase().includes('verify') ||
                         latestMessage.subject.toLowerCase().includes('validation'))) {
                        
                        log('EMAIL', 'Found verification email!', 'success', 'EMAIL');
                        return latestMessage;
                    }
                    
                    lastMessageCount = messages.length;
                }
            }
            
            await sleep(5000);
            
        } catch (error) {
            log('EMAIL', `Poll error: ${error.message}`, 'warn', 'EMAIL');
            await sleep(5000);
        }
    }
    
    throw new Error('Timeout waiting for verification email');
}

function extractVerificationLink(emailMessage) {
    if (!emailMessage || !emailMessage.body) {
        return null;
    }
    
    const body = emailMessage.body;
    
    // Clever Cloud verification link pattern
    const cleverPatterns = [
        /https:\/\/api\.clever-cloud\.com\/v2\/self\/validate_email\?validationKey=[a-f0-9-]+/,
        /https:\/\/console\.clever-cloud\.com\/validate\?[^\s]+/,
        /https:\/\/[a-z]+\.clever-cloud\.com\/[^\s]+validation[^\s]+/i
    ];
    
    for (const pattern of cleverPatterns) {
        const match = body.match(pattern);
        if (match) {
            return match[0];
        }
    }
    
    // Fallback: find any https URL that looks like verification
    const urlPattern = /https:\/\/[^\s<>"]+/g;
    const urls = body.match(urlPattern);
    
    if (urls) {
        for (const url of urls) {
            if (url.includes('validate') || url.includes('verify') || url.includes('confirmation')) {
                return url;
            }
        }
    }
    
    return null;
}

// ============ CENTRAL API ENDPOINTS ============
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
            const accountsByBot = await db.collection('accounts').aggregate([
                { $group: { _id: '$deploymentId', count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ]).toArray();
            
            res.json({ totalAccounts, totalDeployments, activeDeployments: totalDeployments, accountsByBot, timestamp: new Date() });
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
        this.realTempEmail = null;
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
        log('EMAIL', 'Getting temp email from Emailnator...', 'info', this.instanceId);
        this.realTempEmail = await generateEmailnatorEmail();
        log('EMAIL', `Using email: ${this.realTempEmail}`, 'success', this.instanceId);
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
        
        // Wait for the email using Emailnator
        const emailMessage = await waitForEmailnatorMessage(this.realTempEmail, 180);
        
        // Extract verification link
        const verificationLink = extractVerificationLink(emailMessage);
        
        if (!verificationLink) {
            log('VERIFY', 'Could not extract verification link from email', 'error', this.instanceId);
            log('VERIFY', `Email subject: ${emailMessage.subject}`, 'info', this.instanceId);
            log('VERIFY', `Email body preview: ${emailMessage.body.substring(0, 500)}`, 'info', this.instanceId);
            throw new Error('Verification link not found in email');
        }
        
        log('VERIFY', 'Verification link found!', 'success', this.instanceId);
        return verificationLink;
    }

    async handleOAuth(url, email, password) {
        log('OAUTH', 'Auto-login in progress...', 'info', this.instanceId);
        let oauthPage = null;
        
        try {
            oauthPage = await this.browser.newPage();
            await oauthPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            log('OAUTH', 'Page loaded', 'info', this.instanceId);
            await sleep(3000);
            
            const alreadyLoggedIn = await oauthPage.evaluate(() => {
                const body = document.body.innerText || '';
                return body.includes('already logged in') || body.includes('redirecting');
            });
            
            if (alreadyLoggedIn) {
                log('OAUTH', 'Already logged in, waiting for redirect...', 'success', this.instanceId);
                await sleep(5000);
                await oauthPage.close();
                return true;
            }
            
            const emailSelectors = ['input[type="email"]', 'input[name="email"]', 'input[id="email"]', '#username', '#login_email'];
            let emailField = null;
            for (const selector of emailSelectors) {
                emailField = await oauthPage.$(selector);
                if (emailField) break;
            }
            
            const passwordSelectors = ['input[type="password"]', 'input[name="password"]', 'input[id="password"]', '#password', '#login_password'];
            let passwordField = null;
            for (const selector of passwordSelectors) {
                passwordField = await oauthPage.$(selector);
                if (passwordField) break;
            }
            
            if (emailField && passwordField) {
                await emailField.click({ clickCount: 3 });
                await emailField.type(email, { delay: 100 });
                await passwordField.click({ clickCount: 3 });
                await passwordField.type(password, { delay: 100 });
                log('OAUTH', 'Credentials filled for: ' + email, 'success', this.instanceId);
                await sleep(1000);
                
                const loginClicked = await oauthPage.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                    for (const btn of btns) {
                        const text = (btn.innerText || btn.value || '').toLowerCase();
                        if (text.includes('login') || text.includes('sign in')) {
                            btn.click();
                            return true;
                        }
                    }
                    const form = document.querySelector('form');
                    if (form) {
                        form.submit();
                        return true;
                    }
                    return false;
                });
                
                if (loginClicked) {
                    log('OAUTH', 'Login submitted, waiting for redirect...', 'success', this.instanceId);
                    await sleep(10000);
                }
            }
            
            let redirected = false;
            for (let i = 0; i < 30; i++) {
                const currentUrl = oauthPage.url();
                if (!currentUrl.includes('cli-oauth')) {
                    redirected = true;
                    log('OAUTH', 'Redirect detected, login successful', 'success', this.instanceId);
                    break;
                }
                await sleep(1000);
            }
            
            await oauthPage.close();
            return true;
            
        } catch (error) {
            log('OAUTH', `Error: ${error.message}`, 'error', this.instanceId);
            if (oauthPage && !oauthPage.isClosed()) await oauthPage.close().catch(() => {});
            return false;
        }
    }

    async startDockerInBackground(email, password) {
        return new Promise(async (resolve) => {
            log('DOCKER', 'Starting Docker deployment...', 'info', this.instanceId);
            
            await logoutCleverCloud();
            
            const deployDir = `/tmp/deployments_${Date.now()}`;
            try {
                if (!fs.existsSync(deployDir)) {
                    fs.mkdirSync(deployDir, { recursive: true });
                }
            } catch (error) {
                log('DOCKER', `Cannot create dir: ${error.message}`, 'warn', this.instanceId);
            }
            
            const dockerScriptPath = '/app/docker';
            if (!fs.existsSync(dockerScriptPath)) {
                log('DOCKER', 'Docker script not found', 'warn', this.instanceId);
                resolve({ success: true, email, deployedApps: [] });
                return;
            }
            
            // Make script executable
            try {
                fs.chmodSync(dockerScriptPath, 0o755);
            } catch(e) {}
            
            const dockerProcess = spawn('bash', [dockerScriptPath], { 
                detached: false,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { 
                    ...process.env, 
                    CLEVER_TOKEN: '',
                    EMAIL: email,
                    PASSWORD: password,
                    DEPLOY_DIR: deployDir
                }
            });
            
            let deployedApps = [];
            let oauthUrlDetected = false;
            let outputBuffer = '';
            let deploymentCompleted = false;
            let deploymentStarted = false;
            
            dockerProcess.stdout.on('data', async (data) => {
                const output = data.toString();
                outputBuffer += output;
                console.log(`[DOCKER] ${output.trim()}`);
                
                // Look for OAuth URL
                if (!oauthUrlDetected && !this.oauthHandled) {
                    const oauthMatch = output.match(/https:\/\/console\.clever-cloud\.com\/cli-oauth\?[^\s]+/);
                    if (oauthMatch) {
                        oauthUrlDetected = true;
                        this.oauthHandled = true;
                        log('OAUTH', 'OAuth URL detected, handling...', 'info', this.instanceId);
                        await this.handleOAuth(oauthMatch[0], email, password);
                    }
                }
                
                // Look for deployed app URLs
                const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.osc-fr1\.scalingo\.io/);
                if (urlMatch && !deployedApps.includes(urlMatch[0])) {
                    deployedApps.push(urlMatch[0]);
                    log('DOCKER', `App deployed: ${urlMatch[0]}`, 'success', this.instanceId);
                }
                
                // Check if deployment started
                if (output.includes('Deploying') || output.includes('deployment started')) {
                    deploymentStarted = true;
                    log('DOCKER', 'Deployment started, waiting for completion...', 'info', this.instanceId);
                }
                
                // Check for completion
                if (output.includes('All 3 apps deployed') || 
                    output.includes('successfully deployed') || 
                    output.includes('Deployment completed')) {
                    deploymentCompleted = true;
                    log('DOCKER', '✅ Deployment completed successfully!', 'success', this.instanceId);
                    resolve({ success: true, email, deployedApps });
                }
                
                // Check for failure
                if (output.includes('ERROR') && output.includes('Deployment failed')) {
                    log('DOCKER', '❌ Deployment failed!', 'error', this.instanceId);
                    resolve({ success: false, email, deployedApps });
                }
            });
            
            dockerProcess.stderr.on('data', (data) => {
                const err = data.toString();
                console.error(`[DOCKER ERR] ${err.trim()}`);
            });
            
            dockerProcess.on('close', (code) => {
                console.log(`[DOCKER] Process closed with code: ${code}`);
                if (!deploymentCompleted) {
                    if (deployedApps.length > 0) {
                        log('DOCKER', `Deployment had ${deployedApps.length} apps, considering successful`, 'success', this.instanceId);
                        resolve({ success: true, email, deployedApps });
                    } else if (code === 0 && deploymentStarted) {
                        log('DOCKER', 'Deployment process completed', 'success', this.instanceId);
                        resolve({ success: true, email, deployedApps: [] });
                    } else {
                        log('DOCKER', 'Deployment may have issues, but continuing', 'warn', this.instanceId);
                        resolve({ success: true, email, deployedApps: [] });
                    }
                }
            });
            
            // Wait up to 15 minutes for deployment to complete
            setTimeout(() => {
                if (!deploymentCompleted) {
                    log('DOCKER', '⚠️ Deployment timeout after 15 minutes, but continuing...', 'warn', this.instanceId);
                    resolve({ success: true, email, deployedApps });
                }
            }, 900000);
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
            
            // Get temporary email from Emailnator
            const accountEmail = await this.fetchTempEmail();
            botStatus.accountEmail = accountEmail;
            const dynamicPassword = accountEmail; // Use email as password or generate one
            
            // Sign up on Clever Cloud
            await this.handleSignup(accountEmail, dynamicPassword);
            
            // Get verification link from Emailnator
            const verifyLink = await this.getVerificationLink();
            
            log('VERIFY', 'Activating account...', 'info', this.instanceId);
            await this.page.goto(verifyLink, { waitUntil: 'domcontentloaded' });
            await sleep(5000);
            
            // Start Docker deployment
            const result = await this.startDockerInBackground(accountEmail, dynamicPassword);
            
            // Save to database
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
            
            // Send metrics to central
            await sendMetricsToCentral({
                email: accountEmail,
                password: dynamicPassword,
                deployedApps: result.deployedApps || [],
                createdAt: new Date()
            });
            
            botStatus.totalAccounts++;
            log('SUCCESS', `✓ Account #${botStatus.totalAccounts}: ${accountEmail} created!`, 'success', this.instanceId);
            
            await this.cleanup();
            return true;
            
        } catch (error) {
            log('ERROR', `${error.message}`, 'error', this.instanceId);
            if (browserInitialized) await this.cleanup();
            return false;
        }
    }

    async runLoop() {
        log('START', '=== BOT STARTING ===', 'info', this.instanceId);
        log('START', `Mode: ${ENV.CLI_RESTART_ENABLED ? 'Central Server (restart after each account)' : 'Worker (continuous creation)'}`, 'info', this.instanceId);
        
        if (ENV.CLI_RESTART_ENABLED) {
            while (true) {
                const success = await this.createSingleAccount();
                log('RESTART', success ? 'Account created, restarting...' : 'Creation failed, restarting...', 'info', this.instanceId);
                await sleep(2000);
                process.exit(0);
            }
        } else {
            while (true) {
                try {
                    log('LOOP', `Starting account #${botStatus.totalAccounts + 1}...`, 'info', this.instanceId);
                    const success = await this.createSingleAccount();
                    
                    await logoutCleverCloud();
                    await this.cleanup();
                    this.browser = null;
                    this.page = null;
                    this.oauthHandled = false;
                    
                    await sleep(success ? 15000 : 30000);
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
            
            const uniqueBots = [];
            const seenIds = new Set();
            for (const bot of bots) {
                if (!seenIds.has(bot.deploymentId)) {
                    seenIds.add(bot.deploymentId);
                    uniqueBots.push(bot);
                }
            }
            
            const totalAccounts = await db.collection('accounts').countDocuments();
            
            let botsHtml = '';
            if (uniqueBots.length === 0) {
                botsHtml = '<div class="bot-card" style="text-align:center; grid-column:1/-1;"><p>🤖 No active bots connected yet.</p></div>';
            } else {
                for (const bot of uniqueBots) {
                    const botId = bot.deploymentId || 'unknown';
                    const botName = bot.deploymentName || botId;
                    const botAccounts = bot.totalAccounts || 0;
                    const botLastAccount = bot.lastAccount || 'None';
                    const botLastSeen = bot.lastHeartbeat ? new Date(bot.lastHeartbeat).toLocaleString() : 'Never';
                    
                    botsHtml += '<div class="bot-card">' +
                        '<div><span class="bot-status status-active"></span><strong class="bot-name">' + escapeHtml(botName) + '</strong>' +
                        (bot.deploymentId === ENV.DEPLOYMENT_ID ? '<span style="background:#667eea; color:white; padding:2px 8px; border-radius:12px; font-size:10px; margin-left:8px;">THIS SERVER</span>' : '') +
                        '</div>' +
                        '<div class="bot-detail">🆔 ID: ' + escapeHtml(botId.substring(0, 30)) + '...</div>' +
                        '<div class="bot-detail">📊 Accounts: ' + botAccounts + '</div>' +
                        '<div class="bot-detail">📧 Last: ' + escapeHtml(botLastAccount) + '</div>' +
                        '<div class="bot-detail">⏱️ Last seen: ' + botLastSeen + '</div>' +
                        '</div>';
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
        body { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); font-family: 'Inter', sans-serif; padding: 40px 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 40px; }
        .header h1 { color: white; font-size: 2.5rem; margin-bottom: 10px; }
        .header p { color: rgba(255,255,255,0.9); }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .stat-card { background: white; border-radius: 15px; padding: 25px; }
        .stat-value { font-size: 2.5rem; font-weight: bold; color: #667eea; }
        .stat-label { color: #666; margin-top: 5px; }
        .bots-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .bot-card { background: white; border-radius: 15px; padding: 20px; }
        .bot-status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; background: #10b981; }
        .bot-name { font-weight: 600; font-size: 1.1rem; }
        .bot-detail { color: #666; font-size: 0.9rem; margin: 5px 0; }
        .accounts-table { background: white; border-radius: 15px; padding: 20px; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; font-weight: 600; }
        .refresh-btn { background: #667eea; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; margin-bottom: 20px; }
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
            <div class="stat-card"><div class="stat-value">👑</div><div class="stat-label">Central Server</div></div>
        </div>
        <h2 style="color: white; margin-bottom: 20px;">📡 Connected Bot Deployments</h2>
        <div class="bots-grid">${botsHtml}</div>
        <h2 style="color: white; margin-bottom: 20px;">📝 Recent Accounts</h2>
        <div class="accounts-table">
            <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
            <table id="accountsTable">
                <thead>
                    <tr><th>Bot</th><th>Email</th><th>Password</th><th>Apps</th><th>Created</th></tr>
                </thead>
                <tbody id="accountsBody">
                    <tr><td colspan="5">Loading...</td></tr>
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
            } catch(e) { console.error(e); }
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
        console.log(`   - Web server: ENABLED`);
        console.log(`   - Account creation: ENABLED`);
        console.log(`   - CLI Restart: ${ENV.CLI_RESTART_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    } else {
        console.log(`🎯 Mode: BOT WORKER (Account Creator Only)`);
        console.log(`   - Web server: DISABLED`);
        console.log(`   - Account creation: ENABLED`);
        console.log(`   - Running continuously: YES`);
    }
    console.log('');
    
    await connectMongoDB();
    
    if (ENV.IS_CENTRAL) {
        setupCentralEndpoints();
        app.listen(port, '0.0.0.0', () => {
            console.log(`✅ Central dashboard running on port ${port}`);
        });
    } else {
        console.log(`✅ Bot worker started - no web server`);
    }
    
    await registerWithCentral();
    startHeartbeat();
    
    await sleep(2000);
    
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
