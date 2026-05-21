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
        
        try {
            await db.collection('accounts').dropIndex('userId_1');
        } catch(e) {}
        try {
            await db.collection('accounts').dropIndex('email_1');
        } catch(e) {}
        
        await db.createCollection('accounts', { capped: false });
        await db.createCollection('metrics', { capped: false });
        await db.createCollection('deployments', { capped: false });
        
        await db.collection('accounts').createIndex({ createdAt: -1 });
        await db.collection('metrics').createIndex({ timestamp: -1 });
        await db.collection('deployments').createIndex({ createdAt: -1 });
        
        console.log('[MongoDB] Collections and indexes created');
        return true;
    } catch (error) {
        console.error('[MongoDB] Connection failed:', error.message);
        return false;
    }
}

// ============ ENVIRONMENT VARIABLES ============
const ENV = {
    BOT_PASSWORD: process.env.BOT_PASSWORD || 'Linuxdistro&84',
    BOT_WAIT_MINUTES: parseInt(process.env.BOT_WAIT_MINUTES) || 5,
    BOT_START_DELAY: parseInt(process.env.BOT_START_DELAY) || 10,
    USE_PROXY: process.env.USE_PROXY === 'true' || false,
    DOCKER_IMAGE: process.env.DOCKER_IMAGE || 'buyrunplace/webwebwebweb8888',
    DOCKER_APP_COUNT: parseInt(process.env.DOCKER_APP_COUNT) || 3,
    HEADLESS_MODE: process.env.HEADLESS_MODE !== 'false',
    CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/app/chrome-linux64/chrome',
    DEBUG_MODE: process.env.DEBUG_MODE === 'true' || false
};

console.log('\n========================================');
console.log('  BOT CONFIGURATION');
console.log('========================================');
console.log(`Bot Settings: Password: ${ENV.BOT_PASSWORD}, Wait: ${ENV.BOT_WAIT_MINUTES}m`);
console.log(`MongoDB: ${MONGODB_URI ? 'Configured' : 'Not configured'}`);
console.log('========================================\n');

// ============ DATABASE OPERATIONS ============
async function saveAccountToDB(account) {
    if (!db) return false;
    try {
        await db.collection('accounts').insertOne({
            ...account,
            createdAt: new Date(),
            instanceId: account.instanceId || 'INSTANCE_1'
        });
        console.log(`[MongoDB] Account saved: ${account.email}`);
        return true;
    } catch (error) {
        if (error.code === 11000) {
            console.log(`[MongoDB] Account ${account.email} already exists, skipping`);
            return true;
        }
        console.error('[MongoDB] Save account error:', error.message);
        return false;
    }
}

async function saveMetricsToDB(metrics) {
    if (!db) return false;
    try {
        await db.collection('metrics').insertOne({
            ...metrics,
            timestamp: new Date()
        });
        return true;
    } catch (error) {
        console.error('[MongoDB] Save metrics error:', error.message);
        return false;
    }
}

async function saveDeploymentToDB(deployment) {
    if (!db) return false;
    try {
        await db.collection('deployments').insertOne({
            ...deployment,
            createdAt: new Date()
        });
        console.log(`[MongoDB] Deployment saved: ${deployment.appName}`);
        return true;
    } catch (error) {
        console.error('[MongoDB] Save deployment error:', error.message);
        return false;
    }
}

async function getAccountsFromDB(limit = 100) {
    if (!db) return [];
    try {
        return await db.collection('accounts')
            .find({})
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();
    } catch (error) {
        console.error('[MongoDB] Get accounts error:', error.message);
        return [];
    }
}

async function getTotalAccountsFromDB() {
    if (!db) return 0;
    try {
        return await db.collection('accounts').countDocuments();
    } catch (error) {
        console.error('[MongoDB] Get total accounts error:', error.message);
        return 0;
    }
}

async function getTodayAccountsFromDB() {
    if (!db) return 0;
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return await db.collection('accounts').countDocuments({
            createdAt: { $gte: today }
        });
    } catch (error) {
        console.error('[MongoDB] Get today accounts error:', error.message);
        return 0;
    }
}

// ============ HELPER FUNCTIONS ============
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(step, message, type = 'info', instanceId = 'MAIN') {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = `[${timestamp}] [${instanceId}] [${step}]`;
    if (type === 'success') console.log(`${prefix} ✓ ${message}`);
    else if (type === 'error') console.log(`${prefix} ✗ ${message}`);
    else if (type === 'warn') console.log(`${prefix} ! ${message}`);
    else console.log(`${prefix} ℹ ${message}`);
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
            log('SYSTEM', `Chromium already installed at: ${chromePath}`, 'success', 'MAIN');
            return chromePath;
        }
    }
    
    log('SYSTEM', 'Installing Chromium at runtime...', 'info', 'MAIN');
    
    try {
        if (!fs.existsSync('/app')) {
            fs.mkdirSync('/app', { recursive: true });
        }
        
        const chromeUrl = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';
        const zipPath = '/tmp/chromium.zip';
        
        log('SYSTEM', 'Downloading Chromium (this may take a minute)...', 'info', 'MAIN');
        await downloadFile(chromeUrl, zipPath);
        log('SYSTEM', 'Download complete', 'success', 'MAIN');
        
        log('SYSTEM', 'Extracting Chromium...', 'info', 'MAIN');
        execSync(`unzip -q ${zipPath} -d /app/`, { stdio: 'inherit' });
        
        if (fs.existsSync(chromePath)) {
            fs.chmodSync(chromePath, 0o755);
            log('SYSTEM', `Chromium installed successfully at: ${chromePath}`, 'success', 'MAIN');
            fs.unlinkSync(zipPath);
            return chromePath;
        } else {
            const findResult = execSync('find /app -name "chrome" -type f 2>/dev/null | head -1', { encoding: 'utf8' }).trim();
            if (findResult) {
                fs.chmodSync(findResult, 0o755);
                log('SYSTEM', `Found Chromium at: ${findResult}`, 'success', 'MAIN');
                return findResult;
            }
            throw new Error('Chrome binary not found after extraction');
        }
    } catch (error) {
        log('SYSTEM', `Failed to install Chromium: ${error.message}`, 'error', 'MAIN');
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
        this.consecutiveFailures = 0;
        this.waitAfterDockerMinutes = ENV.BOT_WAIT_MINUTES;
        this.chromePath = null;
        this.startTime = new Date();
    }

    async initBrowser() {
        log('SYSTEM', 'Setting up browser...', 'info', this.instanceId);
        
        if (!this.chromePath || !fs.existsSync(this.chromePath)) {
            this.chromePath = await installChromiumRuntime();
        }
        
        if (!this.chromePath) {
            throw new Error('Could not install or find Chromium');
        }
        
        const launchOptions = {
            headless: ENV.HEADLESS_MODE,
            executablePath: this.chromePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate',
                '--hide-scrollbars',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-first-run',
                '--safebrowsing-disable-auto-update',
                '--disable-features=TranslateUI',
                '--disable-ipc-flooding-protection',
                '--use-fake-ui-for-media-stream',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--max_old_space_size=512'
            ]
        };
        
        log('SYSTEM', `Launching browser...`, 'success', this.instanceId);
        
        try {
            this.browser = await puppeteer.launch(launchOptions);
            this.page = await this.browser.newPage();
            await this.page.setViewport({ width: 1280, height: 800 });
            this.page.setDefaultTimeout(60000);
            this.page.setDefaultNavigationTimeout(60000);
            const version = await this.browser.version();
            log('SYSTEM', `Browser version: ${version}`, 'success', this.instanceId);
        } catch (error) {
            log('SYSTEM', `Failed to launch: ${error.message}`, 'error', this.instanceId);
            throw error;
        }
    }

    async fetchTempEmail() {
        log('EMAIL', 'Loading 10MinuteMail...', 'info', this.instanceId);
        this.mailPage = await this.browser.newPage();
        this.mailPage.setDefaultTimeout(60000);
        
        try {
            await this.mailPage.goto('https://10minutemail.net/', { 
                waitUntil: 'domcontentloaded', 
                timeout: 60000 
            });
            await sleep(5000);
            
            this.realTempEmail = await this.mailPage.evaluate(() => {
                const emailInput = document.querySelector('#fe_text');
                if (emailInput && emailInput.value) return emailInput.value;
                const emailSpan = document.querySelector('#mailAddress');
                if (emailSpan && emailSpan.textContent) return emailSpan.textContent;
                return null;
            });
            
            if (!this.realTempEmail) {
                throw new Error('Could not extract email');
            }
            
            log('EMAIL', `Temp Email: ${this.realTempEmail}`, 'success', this.instanceId);
            return this.realTempEmail;
        } catch (error) {
            await this.mailPage.close();
            throw error;
        }
    }

    async handleSignup(email, password) {
        log('SIGNUP', 'Opening Clever Cloud Signup...', 'info', this.instanceId);
        
        try {
            await this.page.goto('https://api.clever-cloud.com/v2/sessions/signup', { 
                waitUntil: 'networkidle2', 
                timeout: 60000 
            });
            await sleep(3000);
            
            await this.page.waitForSelector('input[type="email"]', { timeout: 30000 });
            await this.page.type('input[type="email"]', email, { delay: 20 });
            await this.page.type('input[type="password"]', password, { delay: 20 });
            
            log('SIGNUP', 'Accepting terms...', 'info', this.instanceId);
            await this.page.evaluate(() => {
                const checkbox = document.querySelector('input[type="checkbox"]');
                if (checkbox && !checkbox.checked) checkbox.click();
            });

            log('CAPTCHA', 'Triggering ALTCHA...', 'info', this.instanceId);
            await this.page.evaluate(() => {
                const cb = document.querySelector('#altcha_checkbox') || document.querySelector('.altcha input');
                if (cb) { 
                    cb.click(); 
                    ['click', 'change'].forEach(e => cb.dispatchEvent(new Event(e, { bubbles: true }))); 
                }
            });

            log('CAPTCHA', 'Waiting for automatic solution...', 'info', this.instanceId);
            let solved = false;
            for (let i = 0; i < 90; i++) {
                solved = await this.page.evaluate(() => {
                    const input = document.querySelector('input[name="altcha"]');
                    return (input && input.value && input.value.length > 20);
                });
                if (solved) { 
                    log('CAPTCHA', 'Solved automatically!', 'success', this.instanceId); 
                    break; 
                }
                if (i % 10 === 0 && i > 0) {
                    console.log(`  ${i}s waiting for CAPTCHA...`);
                }
                await sleep(1000);
            }
            
            if (!solved) {
                log('CAPTCHA', 'WARNING: CAPTCHA may not have solved!', 'warn', this.instanceId);
            }
            
            log('SIGNUP', 'Submitting form...', 'info', this.instanceId);
            
            const signupResult = await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const signupBtn = buttons.find(x => x.innerText.toLowerCase().includes('sign up') || x.innerText.toLowerCase().includes('create account'));
                if (signupBtn) {
                    signupBtn.click();
                    return 'clicked';
                }
                return 'not found';
            });
            
            log('SIGNUP', `Signup button result: ${signupResult}`, 'info', this.instanceId);
            
            await sleep(8000);
            
            const currentUrl = this.page.url();
            log('SIGNUP', `Current URL after signup: ${currentUrl}`, 'info', this.instanceId);
            
        } catch (error) {
            log('SIGNUP', `Failed: ${error.message}`, 'error', this.instanceId);
            throw error;
        }
    }

    async getVerificationLink() {
        log('VERIFY', 'Polling for email content (4m limit)...', 'info', this.instanceId);
        const startTime = Date.now();
        let emailFound = false;
        let retryCount = 0;

        while (true) {
            if (Date.now() - startTime > 240000) {
                throw new Error("RESTART_NEEDED - No verification email after 4 minutes");
            }

            try {
                let link = await this.mailPage.evaluate(() => {
                    const regex = /https:\/\/api\.clever-cloud\.com\/v2\/self\/validate_email\?validationKey=[a-f0-9-]+/;
                    const match = document.documentElement.innerHTML.match(regex);
                    return match ? match[0] : null;
                });

                if (link) {
                    log('VERIFY', 'Verification link caught!', 'success', this.instanceId);
                    return link;
                }

                if (!emailFound) {
                    const rowClicked = await this.mailPage.evaluate(() => {
                        const rows = Array.from(document.querySelectorAll('#maillist tr, .mail-list tr, .inbox tr, [class*="mail"] tr'));
                        const cleverRow = rows.find(r => {
                            const text = (r.innerText || '').toLowerCase();
                            return text.includes('clever cloud') || text.includes('clever-cloud') || text.includes('clevercloud');
                        });
                        if (cleverRow) {
                            const a = cleverRow.querySelector('a');
                            if (a) { 
                                a.click(); 
                                return true; 
                            }
                        }
                        return false;
                    });
                    
                    if (rowClicked) { 
                        emailFound = true; 
                        log('VERIFY', 'Email found, extracting link...', 'success', this.instanceId);
                        await sleep(8000); 
                        continue; 
                    }
                }

                if (retryCount % 6 === 0 && retryCount > 0) {
                    log('VERIFY', 'Refreshing inbox...', 'info', this.instanceId);
                    await this.mailPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                    await sleep(3000);
                }

                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                console.log(`  Waiting for email... ${elapsed}s / 240s`);
                
                await sleep(5000);
                retryCount++;
                
            } catch (error) {
                log('VERIFY', `Polling error: ${error.message}`, 'warn', this.instanceId);
                await sleep(5000);
                retryCount++;
            }
        }
    }

    async handleOAuth(url, email, password) {
        log('OAUTH', `Opening OAuth URL...`, 'info', this.instanceId);
        
        try {
            const oauthPage = await this.browser.newPage();
            await oauthPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            log('OAUTH', 'OAuth page loaded, looking for login form...', 'info', this.instanceId);
            await sleep(5000);
            
            const credentialsFilled = await oauthPage.evaluate((email, password) => {
                const emailSelectors = ['input[type="email"]', 'input[name="email"]', 'input[id="email"]'];
                const passwordSelectors = ['input[type="password"]', 'input[name="password"]', 'input[id="password"]'];
                
                let emailField = null, passwordField = null;
                for (const selector of emailSelectors) {
                    emailField = document.querySelector(selector);
                    if (emailField) break;
                }
                for (const selector of passwordSelectors) {
                    passwordField = document.querySelector(selector);
                    if (passwordField) break;
                }
                
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
                    if (loginButton) { loginButton.click(); return true; }
                    const form = document.querySelector('form');
                    if (form) { form.submit(); return true; }
                    return false;
                });
                
                if (loginClicked) log('OAUTH', 'Login button clicked!', 'success', this.instanceId);
            }
            
            await sleep(8000);
            await oauthPage.close();
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
            
            log('DOCKER', `Starting background process for ${email}...`, 'info', this.instanceId);
            
            const dockerScriptPath = '/app/docker';
            if (!fs.existsSync(dockerScriptPath)) {
                reject(new Error('Docker script not found'));
                return;
            }
            
            try { fs.chmodSync(dockerScriptPath, 0o755); } catch(e) {}
            
            const cmd = `bash ${dockerScriptPath}`;
            const dockerProcess = spawn('bash', ['-c', cmd], { 
                detached: true, 
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            this.activeDockerProcesses.push({ id: dockerId, process: dockerProcess, email, logFile, pid: dockerProcess.pid });
            
            fs.writeFileSync(logFile, `--- DOCKER SESSION: ${new Date().toLocaleString()} ---\n`);
            fs.appendFileSync(logFile, `Email: ${email}\nPassword: ${password}\nCommand: ${cmd}\n\n`);
            
            let dockerCompleted = false;
            let oauthHandled = false;
            let deployedApps = [];
            let allAppsDeployed = false;
            let appCount = 0;
            
            const extractOAuthUrl = (output) => {
                const match = output.match(/https:\/\/console\.clever-cloud\.com\/cli-oauth\?[^\s]+/);
                return match ? match[0] : null;
            };
            
            const extractAppUrl = (output) => {
                const match = output.match(/https:\/\/[a-z0-9-]+\.osc-fr1\.scalingo\.io/);
                return match ? match[0] : null;
            };
            
            dockerProcess.stdout.on('data', async (data) => {
                const output = data.toString();
                fs.appendFileSync(logFile, output);
                console.log(`[DOCKER] ${output.trim()}`);
                
                const appUrl = extractAppUrl(output);
                if (appUrl && !deployedApps.includes(appUrl)) {
                    deployedApps.push(appUrl);
                    appCount++;
                    log('DOCKER', `App ${appCount}/3 deployed: ${appUrl}`, 'success', this.instanceId);
                    saveDeploymentToDB({
                        appName: appUrl.split('//')[1].split('.')[0],
                        url: appUrl,
                        email: email,
                        instanceId: this.instanceId
                    });
                }
                
                if (appCount >= 3 && !allAppsDeployed) {
                    allAppsDeployed = true;
                    log('DOCKER', '✅ All 3 apps deployed successfully!', 'success', this.instanceId);
                }
                
                if (!oauthHandled && !dockerCompleted) {
                    const oauthUrl = extractOAuthUrl(output);
                    if (oauthUrl) {
                        oauthHandled = true;
                        this.handleOAuth(oauthUrl, email, password).catch(e => console.error(e));
                        sleep(10000);
                    }
                }
                
                if (!dockerCompleted && (allAppsDeployed || output.includes('All 3 apps deployed'))) {
                    dockerCompleted = true;
                    const accountData = {
                        email: email,
                        password: password,
                        completedAt: new Date(),
                        instanceId: this.instanceId,
                        deployedApps: deployedApps,
                        loopCount: this.loopCount
                    };
                    this.completedAccounts.push(accountData);
                    saveAccountToDB(accountData);
                    fs.appendFileSync(`accounts_${this.instanceId}.csv`, `${email},${password},${new Date().toISOString()}\n`);
                    resolve({ success: true, email, deployedApps });
                }
            });
            
            dockerProcess.stderr.on('data', (data) => {
                const err = data.toString();
                fs.appendFileSync(logFile, `[STDERR] ${err}`);
                console.error(`[DOCKER ERR] ${err.trim()}`);
            });
            
            dockerProcess.on('close', async (code) => {
                fs.appendFileSync(logFile, `\n--- EXITED WITH CODE ${code} ---\n`);
                const index = this.activeDockerProcesses.findIndex(p => p.id === dockerId);
                if (index !== -1) this.activeDockerProcesses.splice(index, 1);
                
                if (!dockerCompleted && (appCount > 0 || oauthHandled || code === 0)) {
                    dockerCompleted = true;
                    const accountData = {
                        email: email,
                        password: password,
                        completedAt: new Date(),
                        instanceId: this.instanceId,
                        deployedApps: deployedApps,
                        loopCount: this.loopCount,
                        warning: appCount < 3 ? `Only ${appCount}/3 apps deployed` : 'OAuth completed'
                    };
                    this.completedAccounts.push(accountData);
                    saveAccountToDB(accountData);
                    fs.appendFileSync(`accounts_${this.instanceId}.csv`, `${email},${password},${new Date().toISOString()},WARNING\n`);
                    resolve({ success: true, email, deployedApps });
                } else if (!dockerCompleted) {
                    reject(new Error(`Docker exited with code ${code} before deployment complete`));
                }
            });
            
            dockerProcess.unref();
            
            setTimeout(() => {
                if (!dockerCompleted) {
                    dockerCompleted = true;
                    if (appCount > 0) {
                        log('DOCKER', `Timeout after 30 minutes, but ${appCount}/3 apps deployed`, 'warn', this.instanceId);
                        const accountData = {
                            email: email,
                            password: password,
                            completedAt: new Date(),
                            instanceId: this.instanceId,
                            deployedApps: deployedApps,
                            loopCount: this.loopCount,
                            warning: `Timeout - only ${appCount}/3 apps deployed`
                        };
                        this.completedAccounts.push(accountData);
                        saveAccountToDB(accountData);
                        fs.appendFileSync(`accounts_${this.instanceId}.csv`, `${email},${password},${new Date().toISOString()},TIMEOUT\n`);
                        resolve({ success: true, email, deployedApps, warning: 'Timeout' });
                    } else {
                        reject(new Error('Docker timeout after 30 minutes with no apps deployed'));
                    }
                    try { process.kill(dockerProcess.pid, 'SIGTERM'); } catch(e) {}
                }
            }, 1800000);
        });
    }

    async cleanup() {
        if (this.browser) await this.browser.close();
    }

    async run() {
        if (this.startDelay > 0) {
            log('START', `Waiting ${this.startDelay} seconds...`, 'warn', this.instanceId);
            await sleep(this.startDelay * 1000);
        }
        
        log('START', `=== Instance ${this.instanceId} Starting ===`, 'info', this.instanceId);
        
        // Run one account creation cycle
        try {
            await this.initBrowser();
            
            const email = await this.fetchTempEmail();
            await this.handleSignup(email, this.password);
            const verifyLink = await this.getVerificationLink();
            
            log('VERIFY', 'Activating account...', 'info', this.instanceId);
            await this.page.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sleep(5000);
            
            log('DOCKER', 'Starting Docker deployment, waiting for completion...', 'info', this.instanceId);
            const result = await this.startDockerInBackground(email, this.password);
            
            log('FINISH', `Account ${email} created successfully! Deployed ${result.deployedApps?.length || 3} apps`, 'success', this.instanceId);
            
            const totalAccounts = await getTotalAccountsFromDB();
            const todayAccounts = await getTodayAccountsFromDB();
            await saveMetricsToDB({
                totalAccounts: totalAccounts + 1,
                completedToday: todayAccounts + 1,
                loopCount: this.loopCount,
                failedAttempts: this.consecutiveFailures,
                uptime: process.uptime(),
                deployedApps: result.deployedApps || []
            });
            
            await this.cleanup();
            this.consecutiveFailures = 0;
            
            await sleep(3000);
            
            log('RESTART', 'Account created successfully. Exiting for restart...', 'info', this.instanceId);
            log('RESTART', 'Scalingo will automatically restart the container with a new IP.', 'warn', this.instanceId);
            
            // Force exit - Scalingo will restart automatically
            process.exit(0);
            
        } catch (e) {
            this.consecutiveFailures++;
            log('ERROR', `${e.message} (failure ${this.consecutiveFailures})`, 'error', this.instanceId);
            await this.cleanup();
            
            await saveMetricsToDB({
                error: e.message,
                failureCount: this.consecutiveFailures,
                loopCount: this.loopCount,
                timestamp: new Date()
            });
            
            // Wait before retry
            const backoff = Math.min(60000, 10000 * Math.pow(2, this.consecutiveFailures));
            log('RESTART', `Waiting ${backoff/1000}s before exit...`, 'warn', this.instanceId);
            await sleep(backoff);
            
            // Exit to restart
            process.exit(1);
        }
    }

    stop() {
        this.isRunning = false;
    }
}

// ============ METRICS ============
let metrics = {
    startTime: new Date(),
    totalAccounts: 0,
    completedToday: 0,
    failedAttempts: 0,
    currentLoopCount: 0,
    botStatus: 'starting',
    botInstance: null
};

async function updateMetrics() {
    metrics.totalAccounts = await getTotalAccountsFromDB();
    metrics.completedToday = await getTodayAccountsFromDB();
}

function getSystemMetrics() {
    return {
        cpuUsage: os.loadavg()[0].toFixed(2),
        memoryUsage: {
            total: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2),
            free: (os.freemem() / 1024 / 1024 / 1024).toFixed(2),
            used: ((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(2),
            percentage: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(1)
        },
        uptime: process.uptime(),
        platform: os.platform(),
        hostname: os.hostname()
    };
}

function startBot() {
    if (metrics.botInstance) {
        console.log('[SERVER] Bot already running');
        return;
    }
    
    console.log('[SERVER] Starting bot...');
    const bot = new CleverCloudBot('INSTANCE_1', ENV.BOT_PASSWORD, ENV.BOT_START_DELAY);
    metrics.botInstance = bot;
    metrics.botStatus = 'running';
    metrics.startTime = new Date();
    
    const interval = setInterval(async () => {
        await updateMetrics();
        metrics.currentLoopCount = bot.loopCount;
    }, 10000);
    
    bot.run().catch(error => {
        console.error('[SERVER] Bot error:', error);
        metrics.botStatus = 'error';
        process.exit(1);
    });
}

// ============ EXPRESS ROUTES ============
app.get('/api/metrics', async (req, res) => {
    await updateMetrics();
    const systemMetrics = getSystemMetrics();
    res.json({
        current: {
            ...metrics,
            system: systemMetrics
        },
        timestamp: new Date()
    });
});

app.get('/api/accounts', async (req, res) => {
    const accounts = await getAccountsFromDB(100);
    res.json(accounts);
});

app.get('/api/stats', async (req, res) => {
    const total = await getTotalAccountsFromDB();
    const today = await getTodayAccountsFromDB();
    res.json({
        totalAccounts: total,
        todayAccounts: today,
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

app.post('/api/restart', async (req, res) => {
    res.json({ success: true, message: 'Restarting...' });
    setTimeout(() => {
        process.exit(0);
    }, 1000);
});

// Dashboard HTML
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Clever Cloud Bot Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Arial, sans-serif; background: #f5f5f5; color: #1e1e2f; }
        .container { max-width: 1400px; margin: 0 auto; padding: 24px; }
        .header { margin-bottom: 32px; }
        h1 { font-size: 28px; font-weight: 600; color: #1a1a2e; margin-bottom: 8px; }
        .subtitle { color: #666; font-size: 14px; }
        .card { background: white; border-radius: 16px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); margin-bottom: 24px; }
        .card-title { font-size: 16px; font-weight: 600; color: #333; margin-bottom: 16px; }
        .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
        .metric-card { background: white; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .metric-value { font-size: 32px; font-weight: 700; color: #1a73e8; margin-bottom: 8px; }
        .metric-label { font-size: 13px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
        .table-responsive { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 12px; background: #f8f9fa; font-weight: 600; font-size: 13px; color: #666; }
        td { padding: 12px; border-bottom: 1px solid #eee; font-size: 13px; }
        .status { display: inline-flex; align-items: center; gap: 6px; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #4caf50; animation: pulse 2s infinite; }
        .status-dot.stopped { background: #f44336; animation: none; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .refresh-btn { background: #1a73e8; color: white; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500; }
        .refresh-btn:hover { background: #1557b0; }
        @media (max-width: 768px) {
            .container { padding: 16px; }
            .metric-value { font-size: 24px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Clever Cloud Bot Dashboard</h1>
            <p class="subtitle">Creates one account then restarts for new IP | Data stored in MongoDB</p>
        </div>
        
        <div class="metrics-grid">
            <div class="metric-card"><div class="metric-value" id="totalAccounts">0</div><div class="metric-label">Total Accounts</div></div>
            <div class="metric-card"><div class="metric-value" id="todayAccounts">0</div><div class="metric-label">Today's Accounts</div></div>
            <div class="metric-card"><div class="metric-value" id="loopCount">0</div><div class="metric-label">Loop Count</div></div>
            <div class="metric-card"><div class="metric-value" id="failedAttempts">0</div><div class="metric-label">Failed Attempts</div></div>
            <div class="metric-card"><div class="metric-value" id="cpuUsage">0%</div><div class="metric-label">CPU Usage</div></div>
            <div class="metric-card"><div class="metric-value" id="memoryUsage">0%</div><div class="metric-label">Memory Usage</div></div>
        </div>
        
        <div class="card">
            <div class="card-title">📊 System Status <button class="refresh-btn" onclick="refreshData()" style="margin-left: 10px;">Refresh</button></div>
            <div class="status"><span class="status-dot" id="statusDot"></span><span id="botStatus">Loading...</span><span style="margin-left: 20px;">Started: <span id="startTime">-</span></span><span style="margin-left: 20px;">Uptime: <span id="uptime">-</span></span></div>
            <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; color: #666;">
                ✅ MongoDB Connected | 🔄 Restarts after each account | 🌐 New IP each restart
            </div>
        </div>
        
        <div class="card">
            <div class="card-title">📋 Recent Accounts</div>
            <div class="table-responsive">
                <table id="accountsTable">
                    <thead><tr><th>Email</th><th>Password</th><th>Date</th><th>Apps</th></tr></thead>
                    <tbody id="accountsBody"><tr><td colspan="4">Loading...</tr</tbody>
                </table>
            </div>
        </div>
    </div>
    
    <script>
        async function fetchMetrics() {
            try {
                const res = await fetch('/api/metrics');
                const data = await res.json();
                if (data.current) {
                    document.getElementById('totalAccounts').textContent = data.current.totalAccounts || 0;
                    document.getElementById('todayAccounts').textContent = data.current.completedToday || 0;
                    document.getElementById('loopCount').textContent = data.current.currentLoopCount || 0;
                    document.getElementById('failedAttempts').textContent = data.current.failedAttempts || 0;
                    document.getElementById('cpuUsage').textContent = (data.current.system?.cpuUsage || 0) + '%';
                    document.getElementById('memoryUsage').textContent = (data.current.system?.memoryUsage?.percentage || 0) + '%';
                    
                    const statusDot = document.getElementById('statusDot');
                    if (data.current.botStatus === 'running') {
                        statusDot.className = 'status-dot';
                        document.getElementById('botStatus').textContent = 'Running';
                    } else {
                        statusDot.className = 'status-dot stopped';
                        document.getElementById('botStatus').textContent = 'Restarting for new IP';
                    }
                    
                    document.getElementById('startTime').textContent = new Date(data.current.startTime).toLocaleString();
                    if (data.current.system?.uptime) {
                        const hours = Math.floor(data.current.system.uptime / 3600);
                        const minutes = Math.floor((data.current.system.uptime % 3600) / 60);
                        document.getElementById('uptime').textContent = hours + 'h ' + minutes + 'm';
                    }
                }
            } catch(e) { console.error(e); }
        }
        
        async function fetchAccounts() {
            try {
                const res = await fetch('/api/accounts');
                const accounts = await res.json();
                const tbody = document.getElementById('accountsBody');
                if (!accounts || accounts.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="4">No accounts found</tr';
                    return;
                }
                let html = '';
                for (let i = 0; i < Math.min(accounts.length, 20); i++) {
                    const acc = accounts[i];
                    html += '<tr><td>' + acc.email + '</td><td>' + acc.password + '</td><td>' + new Date(acc.createdAt).toLocaleString() + '</td><td>' + (acc.deployedApps?.length || 3) + '</td>';
                }
                tbody.innerHTML = html;
            } catch(e) { console.error(e); }
        }
        
        async function refreshData() {
            await Promise.all([fetchMetrics(), fetchAccounts()]);
        }
        refreshData();
        setInterval(refreshData, 10000);
    </script>
</body>
</html>`;
    
    res.send(html);
});

// ============ START SERVER ============
async function main() {
    console.log(`\n🚀 Clever Cloud Bot Dashboard Starting...\n`);
    console.log(`📊 Dashboard available at: http://localhost:${port}`);
    console.log(`🔄 Bot will create ONE account then exit - Scalingo will restart with new IP`);
    console.log(`💾 MongoDB: ${MONGODB_URI ? 'Configured' : 'Not configured'}\n`);
    
    await connectMongoDB();
    
    setTimeout(() => {
        startBot();
    }, 5000);
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`✅ Dashboard server running on port ${port}`);
    });
}

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    if (dbClient) {
        await dbClient.close();
        console.log('[MongoDB] Connection closed');
    }
    if (metrics.botInstance) {
        metrics.botInstance.stop();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down...');
    if (dbClient) {
        await dbClient.close();
        console.log('[MongoDB] Connection closed');
    }
    if (metrics.botInstance) {
        metrics.botInstance.stop();
    }
    process.exit(0);
});

main().catch(console.error);
