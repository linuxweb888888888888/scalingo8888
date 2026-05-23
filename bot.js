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
console.log(`Mode: ${IS_CENTRAL_SERVER ? '🔵 CENTRAL SERVER (Dashboard + Bot Worker)' : '🟢 BOT WORKER (Account Creator)'}`);
console.log('========================================\n');

// ============ ENVIRONMENT VARIABLES ============
const ENV = {
    IS_CENTRAL: IS_CENTRAL_SERVER,
    
    BOT_PASSWORD: process.env.BOT_PASSWORD || 'Linuxdistro&84',
    BOT_START_DELAY: parseInt(process.env.BOT_START_DELAY) || 5,
    HEADLESS_MODE: process.env.HEADLESS_MODE !== 'false',
    CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/app/chrome-linux64/chrome',
    CLEVER_TOKEN: process.env.CLEVER_TOKEN || '',
    
    // CLI RESTART IS ONLY ENABLED ON CENTRAL SERVER
    CLI_RESTART_ENABLED: IS_CENTRAL_SERVER && process.env.CLI_RESTART_ENABLED === 'true',
    SCALINGO_API_TOKEN: process.env.SCALINGO_API_TOKEN || '',
    SCALINGO_APP_NAME: process.env.SCALINGO_APP_NAME || '',
    
    DEPLOYMENT_ID: process.env.DEPLOYMENT_ID || `bot-${CURRENT_HOSTNAME}-${Date.now()}`,
    DEPLOYMENT_NAME: process.env.DEPLOYMENT_NAME || CURRENT_HOSTNAME,
    DEPLOYMENT_REGION: process.env.DEPLOYMENT_REGION || 'osc-fr1',
    
    CENTRAL_API_URL: process.env.CENTRAL_API_URL || `https://${CENTRAL_DOMAIN}`,
    CENTRAL_API_KEY: process.env.CENTRAL_API_KEY || 'change-this-secret-key-12345',
    
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888'
};

console.log('Configuration:');
console.log(`  CLI Restart Enabled: ${ENV.CLI_RESTART_ENABLED ? 'YES (Central Server Only)' : 'NO (Workers Run Continuously)'}`);
console.log(`  Headless Mode: ${ENV.HEADLESS_MODE ? 'YES' : 'NO'}`);
console.log(`  Start Delay: ${ENV.BOT_START_DELAY}s`);
console.log(`  Deployment ID: ${ENV.DEPLOYMENT_ID}`);
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

// Install all Chrome dependencies
async function installChromeDependencies() {
    console.log('[SYSTEM] Installing Chrome dependencies...');
    try {
        execSync('apt-get update -qq 2>/dev/null || true', { stdio: 'inherit' });
        execSync(`apt-get install -y -qq --no-install-recommends \
            git wget curl gnupg apt-transport-https ca-certificates unzip \
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

// Install Clever Cloud CLI
async function installCleverCLI() {
    console.log('[CLI] Installing Clever Cloud CLI...');
    try {
        execSync('curl -s https://clever-cloud.com/clever-tools/latest/clever-tools.linux.amd64.tar.gz -L -o /tmp/clever-tools.tar.gz', { stdio: 'inherit' });
        execSync('tar -xzf /tmp/clever-tools.tar.gz -C /tmp', { stdio: 'inherit' });
        execSync('mv /tmp/clever-tools*/clever /usr/local/bin/clever', { stdio: 'inherit' });
        execSync('chmod +x /usr/local/bin/clever', { stdio: 'inherit' });
        execSync('rm -rf /tmp/clever-tools*', { stdio: 'inherit' });
        
        console.log('[CLI] ✅ Clever CLI installed successfully');
        
        const version = execSync('clever --version', { encoding: 'utf8' });
        console.log(`[CLI] Clever version: ${version.trim()}`);
        
        return true;
    } catch (error) {
        console.error('[CLI] Failed to install Clever CLI:', error.message);
        return false;
    }
}

// Login to Clever Cloud
async function loginCleverCloud() {
    console.log('[CLI] Logging into Clever Cloud...');
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
        console.error('[CLI] Failed to login to Clever Cloud:', error.message);
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
        console.log('[CLI] CLI restart disabled - skipping Scalingo CLI installation');
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
            const bots = await db.collection('deployments').find({}).sort({ lastHeartbeat: -1 }).toArray();
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const botsWithStatus = bots.map(bot => ({
                ...bot,
                isActive: bot.lastHeartbeat > fiveMinutesAgo
            }));
            res.json(botsWithStatus);
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
            const totalDeployments = await db.collection('deployments').countDocuments();
            const activeDeployments = await db.collection('deployments').countDocuments({ lastHeartbeat: { $gt: new Date(Date.now() - 5 * 60 * 1000) } });
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
        this.oauthHandled = false;
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

    async handleOAuth(url, email, password) {
        log('OAUTH', 'Auto-login in progress...', 'info', this.instanceId);
        try {
            const oauthPage = await this.browser.newPage();
            
            await oauthPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            log('OAUTH', 'Page loaded, looking for login form...', 'info', this.instanceId);
            
            await sleep(3000);
            
            const emailSelectors = [
                'input[type="email"]',
                'input[name="email"]', 
                'input[id="email"]',
                'input[placeholder*="email" i]',
                'input[placeholder*="Email" i]',
                '#username',
                '#login_email',
                'input[name="username"]'
            ];
            
            let emailField = null;
            for (const selector of emailSelectors) {
                emailField = await oauthPage.$(selector);
                if (emailField) {
                    log('OAUTH', `Found email field with selector: ${selector}`, 'info', this.instanceId);
                    break;
                }
            }
            
            const passwordSelectors = [
                'input[type="password"]',
                'input[name="password"]',
                'input[id="password"]',
                'input[placeholder*="password" i]',
                '#password',
                '#login_password'
            ];
            
            let passwordField = null;
            for (const selector of passwordSelectors) {
                passwordField = await oauthPage.$(selector);
                if (passwordField) {
                    log('OAUTH', `Found password field with selector: ${selector}`, 'info', this.instanceId);
                    break;
                }
            }
            
            if (emailField && passwordField) {
                await emailField.click({ clickCount: 3 });
                await emailField.press('Backspace');
                await emailField.type(email, { delay: 100 });
                log('OAUTH', 'Email filled', 'success', this.instanceId);
                
                await passwordField.click({ clickCount: 3 });
                await passwordField.press('Backspace');
                await passwordField.type(password, { delay: 100 });
                log('OAUTH', 'Password filled', 'success', this.instanceId);
                
                await sleep(1000);
                
                let loginClicked = false;
                
                const buttonSelectors = [
                    'button[type="submit"]',
                    'input[type="submit"]',
                    '.login-button',
                    '#login-button',
                    'button.btn-primary',
                    'button.btn'
                ];
                
                for (const selector of buttonSelectors) {
                    try {
                        const button = await oauthPage.$(selector);
                        if (button) {
                            await button.click();
                            log('OAUTH', `Clicked login button: ${selector}`, 'success', this.instanceId);
                            loginClicked = true;
                            break;
                        }
                    } catch(e) {}
                }
                
                if (!loginClicked) {
                    loginClicked = await oauthPage.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                        for (const btn of buttons) {
                            const text = (btn.innerText || btn.value || '').toLowerCase();
                            if (text.includes('login') || text.includes('sign in') || text.includes('log in')) {
                                btn.click();
                                return true;
                            }
                        }
                        return false;
                    });
                    if (loginClicked) log('OAUTH', 'Clicked login button by text search', 'success', this.instanceId);
                }
                
                if (!loginClicked) {
                    const form = await oauthPage.$('form');
                    if (form) {
                        await form.evaluate(form => form.submit());
                        log('OAUTH', 'Submitted form directly', 'success', this.instanceId);
                        loginClicked = true;
                    }
                }
                
                if (!loginClicked) {
                    await passwordField.press('Enter');
                    log('OAUTH', 'Pressed Enter on password field', 'success', this.instanceId);
                    loginClicked = true;
                }
                
                if (!loginClicked) {
                    log('OAUTH', 'Could not find login button or form', 'warn', this.instanceId);
                }
                
            } else {
                log('OAUTH', 'Could not find email/password fields', 'error', this.instanceId);
            }
            
            await sleep(8000);
            await oauthPage.close();
            log('OAUTH', 'OAuth flow completed', 'success', this.instanceId);
            return true;
            
        } catch (error) {
            log('OAUTH', `Error: ${error.message}`, 'error', this.instanceId);
            return false;
        }
    }

    async startDockerInBackground(email, password) {
        return new Promise(async (resolve, reject) => {
            log('DOCKER', 'Starting Docker deployment...', 'info', this.instanceId);
            
            await installCleverCLI();
            await loginCleverCloud();
            
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
            let oauthUrlDetected = false;
            
            dockerProcess.stdout.on('data', async (data) => {
                const output = data.toString();
                console.log(`[DOCKER] ${output.trim()}`);
                
                if (!oauthUrlDetected && !this.oauthHandled) {
                    const oauthMatch = output.match(/https:\/\/console\.clever-cloud\.com\/cli-oauth\?[^\s]+/);
                    if (oauthMatch) {
                        oauthUrlDetected = true;
                        this.oauthHandled = true;
                        log('OAUTH', 'OAuth URL detected, handling...', 'info', this.instanceId);
                        await this.handleOAuth(oauthMatch[0], email, password);
                    }
                }
                
                const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.osc-fr1\.scalingo\.io/);
                if (urlMatch && !deployedApps.includes(urlMatch[0])) {
                    deployedApps.push(urlMatch[0]);
                    log('DOCKER', `App deployed: ${urlMatch[0]}`, 'success', this.instanceId);
                }
                
                if (output.includes('All 3 apps deployed') || output.includes('successfully deployed')) {
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
            
            setTimeout(() => {
                if (deployedApps.length > 0) {
                    resolve({ success: true, email, deployedApps });
                } else {
                    reject(new Error('Deployment timeout - no apps detected'));
                }
            }, 600000);
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
                    instanceId: this.instanceId,
                    restartMethod: ENV.CLI_RESTART_ENABLED ? 'CLI' : 'None'
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
        log('START', '=== BOT STARTING - WILL CREATE ACCOUNTS CONTINUOUSLY ===', 'info', this.instanceId);
        log('START', `CLI Restart: ${ENV.CLI_RESTART_ENABLED ? 'ENABLED (Central Server Only)' : 'DISABLED (Running Continuously)'}`, 'info', this.instanceId);
        
        // If CLI restart is enabled (central server), we restart after each account
        if (ENV.CLI_RESTART_ENABLED) {
            log('START', 'Central server mode - will restart after each account for new IP', 'info', this.instanceId);
            while (true) {
                try {
                    const success = await this.createSingleAccount();
                    if (success) {
                        log('RESTART', 'Account created, restarting for new IP...', 'info', this.instanceId);
                        await sleep(2000);
                        process.exit(0); // Exit to trigger restart on central server
                    } else {
                        log('RESTART', 'Account creation failed, restarting to retry...', 'warn', this.instanceId);
                        await sleep(5000);
                        process.exit(0);
                    }
                } catch (error) {
                    log('ERROR', `Fatal: ${error.message}`, 'error', this.instanceId);
                    await sleep(5000);
                    process.exit(0);
                }
            }
        } else {
            // Bot workers run continuously without restarting
            log('START', 'Bot worker mode - will create accounts continuously without restart', 'info', this.instanceId);
            while (true) {
                try {
                    log('LOOP', `Starting account creation #${botStatus.totalAccounts + 1}...`, 'info', this.instanceId);
                    
                    const success = await this.createSingleAccount();
                    
                    if (success) {
                        log('LOOP', 'Account created successfully. Waiting 10 seconds before next account...', 'info', this.instanceId);
                        await sleep(10000);
                    } else {
                        log('LOOP', 'Account creation failed. Waiting 30 seconds before retry...', 'warn', this.instanceId);
                        await sleep(30000);
                    }
                    
                } catch (error) {
                    log('LOOP', `Unexpected error: ${error.message}`, 'error', this.instanceId);
                    await sleep(30000);
                }
            }
        }
    }
}

// ============ DASHBOARD ============
app.get('/', async (req, res) => {
    try {
        const bots = await db.collection('deployments').find({}).toArray();
        const totalAccounts = await db.collection('accounts').countDocuments();
        const activeBots = bots.filter(b => b.lastHeartbeat && b.lastHeartbeat > new Date(Date.now() - 5 * 60 * 1000)).length;
        
        let botsHtml = '';
        for (const bot of bots) {
            const botId = bot.deploymentId || 'unknown';
            const botName = bot.deploymentName || botId;
            const botAccounts = bot.totalAccounts || 0;
            const botLastAccount = bot.lastAccount || 'None';
            const botLastSeen = bot.lastHeartbeat ? new Date(bot.lastHeartbeat).toLocaleString() : 'Never';
            const isActive = bot.lastHeartbeat && bot.lastHeartbeat > new Date(Date.now() - 5 * 60 * 1000);
            
            botsHtml += `
                <div class="bot-card">
                    <div>
                        <span class="bot-status ${isActive ? 'status-active' : 'status-inactive'}"></span>
                        <strong class="bot-name">${escapeHtml(botName)}</strong>
                        ${bot.deploymentId === ENV.DEPLOYMENT_ID ? '<span style="background:#667eea; color:white; padding:2px 8px; border-radius:12px; font-size:10px; margin-left:8px;">THIS SERVER</span>' : ''}
                    </div>
                    <div class="bot-detail">🆔 ID: ${escapeHtml(botId.substring(0, 20))}...</div>
                    <div class="bot-detail">📊 Accounts: ${botAccounts}</div>
                    <div class="bot-detail">📧 Last: ${escapeHtml(botLastAccount)}</div>
                    <div class="bot-detail">⏱️ Last seen: ${botLastSeen}</div>
                </div>
            `;
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
        .bot-status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
        .status-active { background: #10b981; box-shadow: 0 0 5px #10b981; }
        .status-inactive { background: #ef4444; }
        .bot-name { font-weight: 600; font-size: 1.1rem; margin-bottom: 10px; }
        .bot-detail { color: #666; font-size: 0.9rem; margin: 5px 0; }
        .accounts-table { background: white; border-radius: 15px; padding: 20px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); overflow-x: auto; }
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
            <p>Monitoring ${bots.length} bot deployments • ${totalAccounts} total accounts created</p>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-value">${totalAccounts}</div><div class="stat-label">Total Accounts</div></div>
            <div class="stat-card"><div class="stat-value">${bots.length}</div><div class="stat-label">Connected Bots</div></div>
            <div class="stat-card"><div class="stat-value">${activeBots}</div><div class="stat-label">Active Bots</div></div>
            <div class="stat-card"><div class="stat-value">👑</div><div class="stat-label">Central Server</div></div>
        </div>
        
        <h2 style="color: white; margin-bottom: 20px;">📡 Connected Bot Deployments</h2>
        <div class="bots-grid">
            ${botsHtml}
        </div>
        
        <h2 style="color: white; margin-bottom: 20px;">📝 Recent Accounts</h2>
        <div class="accounts-table">
            <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
            <table id="accountsTable">
                <thead><tr><th>Bot</th><th>Email</th><th>Password</th><th>Apps</th><th>Created</th></tr></thead>
                <tbody id="accountsBody"><tr><td colspan="5">Loading...</td></tr></tbody>
            </table>
        </div>
    </div>
    <script>
        function escapeHtml(text) {
            if (!text) return '';
            return text.replace(/[&<>]/g, function(m) {
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
            }
        }
        loadAccounts();
        setInterval(loadAccounts, 10000);
    </script>
</body>
</html>`;
        
        res.send(html);
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).send('Dashboard error: ' + error.message);
    }
});

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// ============ START APPLICATION ============
async function main() {
    console.log(`\n🚀 Starting application...`);
    console.log(`📊 Dashboard: http://localhost:${port}`);
    console.log(`🎯 Mode: ${ENV.IS_CENTRAL ? 'CENTRAL SERVER (Dashboard + Bot)' : 'BOT WORKER'}\n`);
    
    await connectMongoDB();
    
    // Setup API endpoints
    setupCentralEndpoints();
    
    // Register with central (if we are central, register ourselves)
    await registerWithCentral();
    
    // Start heartbeat
    startHeartbeat();
    
    // Start web server
    app.listen(port, '0.0.0.0', () => {
        console.log(`✅ Server running on port ${port}`);
    });
    
    // Small delay to ensure everything is ready
    await sleep(2000);
    
    // Start the bot loop
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
