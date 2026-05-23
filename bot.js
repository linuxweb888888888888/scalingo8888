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
console.log(`Bot Mode: Creates ONE account, password = email address`);
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
    
    if (!appName) {
        log('RESTART', 'SCALINGO_APP_NAME not set', 'error', 'MAIN');
        return false;
    }
    
    if (!apiToken) {
        log('RESTART', 'SCALINGO_API_TOKEN not set', 'error', 'MAIN');
        return false;
    }
    
    log('RESTART', `Restarting ${appName} via CLI...`, 'info', 'MAIN');
    
    return new Promise((resolve) => {
        const cmd = `${cliPath} login --api-token "${apiToken}" && ${cliPath} --app ${appName} restart`;
        
        const child = spawn('bash', ['-c', cmd]);
        
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
                log('RESTART', `CLI restart failed with code ${code}`, 'error', 'MAIN');
                resolve(false);
            }
        });
    });
}

// ============ TEST SCALINGO CLI ============
function testScalingoCLI() {
    const cliPath = '/app/bin/scalingo';
    
    console.log('\n========================================');
    console.log('  TESTING SCALINGO CLI');
    console.log('========================================');
    
    if (fs.existsSync(cliPath)) {
        console.log(`✅ Scalingo CLI found at: ${cliPath}`);
        try {
            const version = execSync(`${cliPath} version`, { encoding: 'utf8' });
            console.log(`✅ Version: ${version.trim()}`);
        } catch(e) {
            console.log(`❌ Failed to get version: ${e.message}`);
        }
    } else {
        console.log('❌ Scalingo CLI not found');
    }
    
    console.log('========================================\n');
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
            
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            console.log(`  Waiting for email... ${elapsed}s / 180s`);
            await sleep(5000);
        }
        
        throw new Error('No verification email received after 3 minutes');
    }

    async handleOAuth(url, email, password) {
        log('OAUTH', '========================================', 'info', this.instanceId);
        log('OAUTH', 'Opening OAuth URL for auto-login...', 'info', this.instanceId);
        
        let oauthPage = null;
        
        try {
            oauthPage = await this.browser.newPage();
            
            await oauthPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            log('OAUTH', 'OAuth page loaded', 'success', this.instanceId);
            
            await sleep(3000);
            
            const alreadyLoggedIn = await oauthPage.evaluate(() => {
                const body = document.body.innerText || '';
                return body.includes('already logged in') || body.includes('redirecting') || body.includes('You are already logged in');
            });
            
            if (alreadyLoggedIn) {
                log('OAUTH', 'Already logged in, waiting for redirect...', 'success', this.instanceId);
                await sleep(5000);
                await oauthPage.close();
                return true;
            }
            
            const emailSelectors = [
                'input[type="email"]', 'input[name="email"]', 'input[id="email"]',
                'input[placeholder*="email" i]', '#username', '#login_email'
            ];
            
            let emailField = null;
            for (const selector of emailSelectors) {
                try {
                    emailField = await oauthPage.$(selector);
                    if (emailField) {
                        log('OAUTH', `Found email field`, 'info', this.instanceId);
                        break;
                    }
                } catch(e) {}
            }
            
            const passwordSelectors = [
                'input[type="password"]', 'input[name="password"]', 'input[id="password"]',
                'input[placeholder*="password" i]', '#password', '#login_password'
            ];
            
            let passwordField = null;
            for (const selector of passwordSelectors) {
                try {
                    passwordField = await oauthPage.$(selector);
                    if (passwordField) {
                        log('OAUTH', `Found password field`, 'info', this.instanceId);
                        break;
                    }
                } catch(e) {}
            }
            
            if (emailField && passwordField) {
                await emailField.click({ clickCount: 3 });
                await emailField.type(email, { delay: 100 });
                log('OAUTH', 'Email filled', 'success', this.instanceId);
                
                await passwordField.click({ clickCount: 3 });
                await passwordField.type(password, { delay: 100 });
                log('OAUTH', 'Password filled', 'success', this.instanceId);
                
                await sleep(1000);
                
                let loginClicked = false;
                
                const buttonSelectors = [
                    'button[type="submit"]', 'input[type="submit"]',
                    '.login-button', '#login-button', 'button.btn-primary'
                ];
                
                for (const selector of buttonSelectors) {
                    try {
                        const button = await oauthPage.$(selector);
                        if (button) {
                            await button.click();
                            log('OAUTH', `Clicked login button`, 'success', this.instanceId);
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
                    if (loginClicked) log('OAUTH', 'Submitted login', 'success', this.instanceId);
                }
                
                if (!loginClicked) {
                    await passwordField.press('Enter');
                    log('OAUTH', 'Pressed Enter', 'success', this.instanceId);
                }
            } else {
                log('OAUTH', 'Could not find email/password fields', 'error', this.instanceId);
            }
            
            await sleep(8000);
            await oauthPage.close();
            log('OAUTH', 'OAuth flow completed', 'success', this.instanceId);
            log('OAUTH', '========================================', 'info', this.instanceId);
            return true;
            
        } catch (error) {
            log('OAUTH', `OAuth error: ${error.message}`, 'error', this.instanceId);
            if (oauthPage && !oauthPage.isClosed()) {
                try { await oauthPage.close(); } catch(e) {}
            }
            return false;
        }
    }

    async startDockerInBackground(email, password) {
        return new Promise((resolve, reject) => {
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
            
            if (db) {
                await db.collection('accounts').insertOne({
                    email: accountEmail,
                    password: dynamicPassword,
                    deployedApps: result.deployedApps || [],
                    createdAt: new Date(),
                    instanceId: this.instanceId
                });
            }
            
            accountCreated = true;
            botStatus.accountCreated = true;
            
            log('SUCCESS', `✓ Account ${accountEmail} created successfully! Password = ${dynamicPassword}`, 'success', this.instanceId);
            
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
    <title>Clever Cloud Bot • Material Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300;14..32,400;14..32,500;14..32,600;14..32,700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0,200" />
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #f5f7fb; font-family: 'Inter', sans-serif; color: #1e293b; line-height: 1.5; }
        .container { max-width: 1280px; margin: 0 auto; padding: 32px 24px; }
        .header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; margin-bottom: 32px; }
        .title-section h1 { font-size: 28px; font-weight: 600; background: linear-gradient(135deg, #1e293b 0%, #2d3a4f 100%); background-clip: text; -webkit-background-clip: text; color: transparent; margin-bottom: 6px; }
        .subhead { color: #5b6e8c; font-size: 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .status-chip { display: inline-flex; align-items: center; gap: 6px; background: #eef2ff; padding: 4px 12px; border-radius: 40px; font-size: 12px; font-weight: 500; color: #1e40af; }
        .grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 32px; }
        .metric-card { background: white; border-radius: 24px; padding: 20px; border: 1px solid #edf2f7; }
        .metric-icon { background: #f8fafc; width: 44px; height: 44px; border-radius: 28px; display: flex; align-items: center; justify-content: center; margin-bottom: 16px; }
        .metric-icon .material-symbols-outlined { font-size: 26px; color: #3b82f6; }
        .metric-value { font-size: 34px; font-weight: 700; color: #0f172a; }
        .metric-label { font-size: 13px; font-weight: 500; color: #5b6e8c; margin-top: 8px; text-transform: uppercase; }
        .data-card { background: white; border-radius: 28px; border: 1px solid #edf2f7; overflow: hidden; margin-bottom: 24px; }
        .card-header { padding: 20px 24px 8px 24px; display: flex; justify-content: space-between; border-bottom: 1px solid #f0f2f5; }
        .card-header h3 { font-size: 18px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .table-wrapper { overflow-x: auto; padding: 0 4px; }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th { text-align: left; padding: 16px 20px; background: #fefefe; font-weight: 600; color: #475569; border-bottom: 1px solid #eef2f6; }
        td { padding: 14px 20px; border-bottom: 1px solid #f1f5f9; color: #1e293b; }
        .email-cell { font-family: monospace; font-weight: 500; background: #f8fafc; padding: 4px 10px; border-radius: 40px; display: inline-block; font-size: 12px; }
        .info-note { background: #f8fafc; border-radius: 20px; padding: 16px 24px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; border: 1px solid #eef2ff; margin-top: 16px; }
        .footer-text { font-size: 12px; color: #7e8aa2; text-align: center; margin-top: 32px; }
        .live-dot { width: 10px; height: 10px; background: #22c55e; border-radius: 50%; display: inline-block; animation: pulse-ring 1.2s infinite; margin-right: 6px; }
        @keyframes pulse-ring { 0% { opacity: 0.6; } 100% { opacity: 1; } }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <div class="title-section">
            <h1>Clever Cloud Bot</h1>
            <div class="subhead">
                <span class="status-chip"><span class="live-dot"></span> ACTIVE · PASSWORD = EMAIL</span>
                <span>⚡ Auto OAuth · IP rotation via CLI restart</span>
            </div>
        </div>
    </div>

    <div class="grid-4">
        <div class="metric-card"><div class="metric-icon"><span class="material-symbols-outlined">group</span></div><div class="metric-value" id="totalAccounts">0</div><div class="metric-label">Total accounts</div></div>
        <div class="metric-card"><div class="metric-icon"><span class="material-symbols-outlined">today</span></div><div class="metric-value" id="todayAccounts">0</div><div class="metric-label">Created today</div></div>
        <div class="metric-card"><div class="metric-icon"><span class="material-symbols-outlined">autorenew</span></div><div class="metric-value" id="restartCount">0</div><div class="metric-label">Restart attempts</div></div>
        <div class="metric-card"><div class="metric-icon"><span class="material-symbols-outlined">memory</span></div><div class="metric-value" id="botState">—</div><div class="metric-label">Bot state</div></div>
    </div>

    <div class="data-card">
        <div class="card-header"><h3><span class="material-symbols-outlined">description</span> Recently created accounts</h3><span style="font-size:12px;">⬇ last 50 records (password = email)</span></div>
        <div class="table-wrapper">
            <table id="accountsTable">
                <thead><tr><th>Email address (also password)</th><th>Deployed Apps</th><th>Created at</th></tr></thead>
                <tbody id="accountsBody"><tr><td colspan="3" style="text-align:center; padding:48px;">Loading secure data...</td></tr></tbody>
            </table>
        </div>
    </div>

    <div class="info-note">
        <span class="material-symbols-outlined">info</span>
        <span>Bot creates exactly ONE account using the temp email as the password, then triggers CLI restart (new IP). OAuth is auto-filled and submitted.</span>
    </div>
    <div class="footer-text">Clever Cloud automation · stealth puppeteer · scalingo restart engine · Password = Email</div>
</div>

<script>
    async function refreshDashboard() {
        try {
            const metricsRes = await fetch('/api/metrics');
            const metrics = await metricsRes.json();
            document.getElementById('totalAccounts').innerText = metrics.totalAccounts || 0;
            document.getElementById('todayAccounts').innerText = metrics.completedToday || 0;
            document.getElementById('restartCount').innerText = metrics.restartCount || 0;
            let stateDisplay = metrics.botState || 'unknown';
            if (metrics.botState === 'running') stateDisplay = '⚙️ running';
            else if (metrics.botState === 'completed') stateDisplay = '✅ completed';
            else if (metrics.botState === 'failed') stateDisplay = '⚠️ failed';
            else if (metrics.botState === 'starting') stateDisplay = '🔄 starting';
            document.getElementById('botState').innerHTML = stateDisplay;
            
            const accountsRes = await fetch('/api/accounts');
            const accounts = await accountsRes.json();
            const tbody = document.getElementById('accountsBody');
            if (accounts && accounts.length) {
                let html = '';
                for (let acc of accounts) {
                    let dateStr = acc.createdAt ? new Date(acc.createdAt).toLocaleString() : 'just now';
                    let appsCount = (acc.deployedApps || []).length;
                    html += '<tr>' +
                        '<td><span class="email-cell">' + (acc.email || 'N/A') + '</span><br><span style="font-size:10px; color:#6c86a3;">(password is same as email)</span></td>' +
                        '<td style="font-size:12px;">' + appsCount + ' app(s) deployed</td>' +
                        '<td style="font-size:12px; color:#4b5563;">' + dateStr + '</td>' +
                    '</tr>';
                }
                tbody.innerHTML = html;
            } else {
                tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:32px;">✨ No accounts yet — waiting for first creation...</td></tr>';
            }
        } catch(e) { console.warn(e); }
    }
    refreshDashboard();
    setInterval(refreshDashboard, 5000);
</script>
</body>
</html>`);
});

// ============ START ============
async function main() {
    console.log(`\n🚀 Clever Cloud Bot Starting...`);
    console.log(`📊 Dashboard: http://localhost:${port}`);
    console.log(`🔐 Mode: Creates ONE account, password = email address`);
    console.log(`\n`);
    
    console.log('[START] Installing Scalingo CLI...');
    installScalingoCLI();
    
    testScalingoCLI();
    
    await connectMongoDB();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`✅ Dashboard server running on port ${port}`);
    });
    
    await sleep(2000);
    
    const bot = new CleverCloudBot('INSTANCE_1', ENV.BOT_START_DELAY);
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
