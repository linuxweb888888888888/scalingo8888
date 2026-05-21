const express = require('express');
const fs = require('fs');
const os = require('os');
const { execSync, spawn } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const { createWriteStream } = require('fs');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Apply stealth plugin
puppeteer.use(StealthPlugin());

const app = express();
const port = process.env.PORT || 3000;

// ============ PROXY MANAGER CLASS ============
class ProxyManager {
    constructor() {
        this.proxies = [];
        this.workingProxies = [];
        this.currentProxyIndex = 0;
        this.lastFetchTime = 0;
        this.requestCount = 0;
        this.minRequestInterval = 1000;
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async waitForRateLimit() {
        const now = Date.now();
        const timeSinceLastFetch = now - this.lastFetchTime;
        if (timeSinceLastFetch < this.minRequestInterval) {
            await this.delay(this.minRequestInterval - timeSinceLastFetch);
        }
        this.lastFetchTime = Date.now();
    }

    async fetchProxies(options = {}) {
        await this.waitForRateLimit();
        
        const defaultOptions = {
            protocol: 'http',
            https: true,
            level: 'anonymous',
            limit: 10,
            countries: [],
            notCountries: [],
            port: null,
            lastChecked: 60,
            timeToConnect: 10,
            cookies: true,
            post: true,
            google: false,
            userAgent: true
        };
        
        const mergedOptions = { ...defaultOptions, ...options };
        
        let url = 'http://pubproxy.com/api/proxy?';
        const params = [];
        
        if (mergedOptions.protocol) params.push(`protocol=${mergedOptions.protocol}`);
        if (mergedOptions.https) params.push(`https=true`);
        if (mergedOptions.level) params.push(`level=${mergedOptions.level}`);
        if (mergedOptions.limit) params.push(`limit=${mergedOptions.limit}`);
        if (mergedOptions.countries && mergedOptions.countries.length > 0) params.push(`country=${mergedOptions.countries.join(',')}`);
        if (mergedOptions.notCountries && mergedOptions.notCountries.length > 0) params.push(`notCountry=${mergedOptions.notCountries.join(',')}`);
        if (mergedOptions.port) params.push(`port=${mergedOptions.port}`);
        if (mergedOptions.lastChecked) params.push(`last_check=${mergedOptions.lastChecked}`);
        if (mergedOptions.timeToConnect) params.push(`time_to_connect=${mergedOptions.timeToConnect}`);
        if (mergedOptions.cookies) params.push(`cookies=true`);
        if (mergedOptions.post) params.push(`post=true`);
        if (mergedOptions.google) params.push(`google=true`);
        if (mergedOptions.userAgent) params.push(`user_agent=true`);
        
        url += params.join('&');
        
        console.log(`[ProxyManager] Fetching proxies...`);
        
        try {
            const response = await axios.get(url, {
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            
            if (response.data && response.data.data && response.data.data.length > 0) {
                this.proxies = response.data.data;
                console.log(`[ProxyManager] Fetched ${this.proxies.length} proxies`);
                return this.proxies;
            }
            return [];
        } catch (error) {
            console.error(`[ProxyManager] Failed to fetch proxies: ${error.message}`);
            return [];
        }
    }

    async testProxy(proxy, timeout = 10000) {
        const proxyUrl = `${proxy.protocol}://${proxy.ip}:${proxy.port}`;
        
        try {
            const agent = new HttpsProxyAgent(proxyUrl);
            const startTime = Date.now();
            const response = await axios.get('https://api.ipify.org?format=json', {
                httpsAgent: agent,
                timeout: timeout,
                proxy: false
            });
            
            const responseTime = Date.now() - startTime;
            
            if (response.status === 200) {
                return { working: true, responseTime: responseTime, ip: response.data.ip, proxyIp: proxy.ip };
            }
        } catch (error) {
            return { working: false, error: error.message };
        }
        
        return { working: false };
    }

    async testMultipleProxies(proxies, maxConcurrent = 5) {
        console.log(`[ProxyManager] Testing ${proxies.length} proxies...`);
        
        const working = [];
        
        for (let i = 0; i < proxies.length; i += maxConcurrent) {
            const batch = proxies.slice(i, i + maxConcurrent);
            const batchPromises = batch.map(async (proxy) => {
                const result = await this.testProxy(proxy);
                if (result.working) {
                    working.push({ ...proxy, responseTime: result.responseTime, testedIp: result.ip });
                }
                return result;
            });
            
            await Promise.all(batchPromises);
            console.log(`[ProxyManager] Tested ${Math.min(i + maxConcurrent, proxies.length)}/${proxies.length} proxies`);
            await this.delay(500);
        }
        
        working.sort((a, b) => a.responseTime - b.responseTime);
        
        console.log(`[ProxyManager] Found ${working.length} working proxies`);
        if (working.length > 0) {
            console.log(`[ProxyManager] Fastest proxy: ${working[0].ip}:${working[0].port} (${working[0].responseTime}ms)`);
        }
        
        this.workingProxies = working;
        return working;
    }

    async refreshProxies(options = {}) {
        this.requestCount++;
        
        if (this.requestCount > 50) {
            console.log('[ProxyManager] Daily request limit reached');
            return [];
        }
        
        const proxies = await this.fetchProxies(options);
        if (proxies.length === 0) return [];
        
        const working = await this.testMultipleProxies(proxies);
        return working;
    }

    getNextProxy() {
        if (this.workingProxies.length === 0) return null;
        const proxy = this.workingProxies[this.currentProxyIndex];
        this.currentProxyIndex = (this.currentProxyIndex + 1) % this.workingProxies.length;
        return proxy;
    }

    getProxyUrl(proxy) {
        if (!proxy) return null;
        return `${proxy.protocol}://${proxy.ip}:${proxy.port}`;
    }

    getProxyAgent(proxy) {
        if (!proxy) return null;
        return new HttpsProxyAgent(this.getProxyUrl(proxy));
    }

    getStats() {
        return {
            totalProxies: this.proxies.length,
            workingProxies: this.workingProxies.length,
            requestsMade: this.requestCount,
            currentProxyIndex: this.currentProxyIndex,
            fastestProxy: this.workingProxies.length > 0 ? `${this.workingProxies[0].ip}:${this.workingProxies[0].port} (${this.workingProxies[0].responseTime}ms)` : 'None'
        };
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

// Download file helper
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

// Install Chromium at runtime
async function installChromiumRuntime() {
    const chromePath = '/app/chrome-linux64/chrome';
    
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
    constructor(instanceId, maxConcurrent, password, startDelay = 0) {
        this.instanceId = instanceId;
        this.browser = null;
        this.page = null;
        this.mailPage = null;
        this.realTempEmail = null;
        this.activeDockerProcesses = [];
        this.completedAccounts = [];
        this.maxConcurrentDocker = maxConcurrent;
        this.password = password;
        this.startDelay = startDelay;
        this.isRunning = true;
        this.loopCount = 0;
        this.consecutiveFailures = 0;
        this.waitAfterDockerMinutes = parseInt(process.env.BOT_WAIT_MINUTES) || 5;
        this.chromePath = null;
        this.proxyManager = new ProxyManager();
        this.useProxy = process.env.USE_PROXY === 'true' || false;
    }

    async getDockerProcessCount() {
        try {
            const { stdout } = await require('util').promisify(require('child_process').exec)(`ps aux | grep "bash /app/docker" | grep "${this.instanceId}" | grep -v grep | wc -l`);
            const count = parseInt(stdout.trim());
            return count;
        } catch (error) {
            return 0;
        }
    }

    async waitForDockerSlot() {
        while (this.isRunning) {
            const currentCount = await this.getDockerProcessCount();
            if (currentCount < this.maxConcurrentDocker) {
                log('DOCKER', `Slot available (${currentCount}/${this.maxConcurrentDocker})`, 'success', this.instanceId);
                break;
            }
            log('DOCKER', `Waiting for slot... (${currentCount}/${this.maxConcurrentDocker} running)`, 'warn', this.instanceId);
            await sleep(10000);
        }
    }

    async initBrowser() {
        log('SYSTEM', 'Setting up browser...', 'info', this.instanceId);
        
        if (!this.chromePath || !fs.existsSync(this.chromePath)) {
            this.chromePath = await installChromiumRuntime();
        }
        
        if (!this.chromePath) {
            throw new Error('Could not install or find Chromium');
        }
        
        // Get proxy if enabled
        let proxyServer = null;
        if (this.useProxy) {
            if (this.proxyManager.workingProxies.length === 0) {
                log('PROXY', 'Refreshing proxy list...', 'info', this.instanceId);
                await this.proxyManager.refreshProxies({
                    protocol: 'http',
                    https: true,
                    level: 'anonymous',
                    limit: 10
                });
            }
            
            const proxy = this.proxyManager.getNextProxy();
            if (proxy) {
                proxyServer = `${proxy.protocol}://${proxy.ip}:${proxy.port}`;
                log('PROXY', `Using proxy: ${proxyServer}`, 'success', this.instanceId);
            } else {
                log('PROXY', 'No working proxies available, continuing without proxy', 'warn', this.instanceId);
            }
        }
        
        const launchOptions = {
            headless: true,
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
        
        // Add proxy if available
        if (proxyServer) {
            launchOptions.args.push(`--proxy-server=${proxyServer}`);
        }
        
        log('SYSTEM', `Launching browser with: ${this.chromePath}`, 'success', this.instanceId);
        
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
                waitUntil: 'domcontentloaded', 
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
                    return (input && input.value.length > 20);
                });
                if (solved) { 
                    log('CAPTCHA', 'Solved automatically!', 'success', this.instanceId); 
                    break; 
                }
                if (i % 10 === 0 && i > 0) {
                    process.stdout.write(`\n  ${i}s `);
                } else {
                    process.stdout.write('.');
                }
                await sleep(1000);
            }
            console.log();

            log('SIGNUP', 'Submitting form...', 'info', this.instanceId);
            await this.page.evaluate(() => {
                const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText.toLowerCase().includes('sign up'));
                if (b) b.click();
            });
            await sleep(8000);
        } catch (error) {
            log('SIGNUP', `Failed: ${error.message}`, 'error', this.instanceId);
            throw error;
        }
    }

    async getVerificationLink() {
        log('VERIFY', 'Polling for email content (4m limit)...', 'info', this.instanceId);
        const startTime = Date.now();
        let emailFound = false;

        while (true) {
            if (Date.now() - startTime > 240000) throw new Error("RESTART_NEEDED");

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
                        const rows = Array.from(document.querySelectorAll('#maillist tr, .mail-list tr'));
                        const cleverRow = rows.find(r => r.innerText.toLowerCase().includes('clever cloud'));
                        if (cleverRow) {
                            const a = cleverRow.querySelector('a');
                            if (a) { a.click(); return true; }
                        }
                        return false;
                    });
                    if (rowClicked) { 
                        emailFound = true; 
                        log('VERIFY', 'Email found, extracting link...', 'success', this.instanceId);
                        await sleep(5000); 
                        continue; 
                    }
                }

                if ((Date.now() - startTime) % 30000 < 5000) {
                    await this.mailPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                }

                process.stdout.write('.');
                await sleep(5000);
                
            } catch (error) {
                await sleep(5000);
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
            
            const cmd = `bash ${dockerScriptPath} webwebwebweb8888 3 start buyrunplace --instance ${this.instanceId}`;
            const dockerProcess = spawn('bash', ['-c', cmd], { 
                detached: true, 
                stdio: ['ignore', 'pipe', 'pipe'] 
            });
            
            this.activeDockerProcesses.push({ id: dockerId, process: dockerProcess, email, logFile, pid: dockerProcess.pid });
            
            fs.writeFileSync(logFile, `--- DOCKER SESSION: ${new Date().toLocaleString()} ---\n`);
            fs.appendFileSync(logFile, `Email: ${email}\nPassword: ${password}\nCommand: ${cmd}\n\n`);
            
            let dockerCompleted = false;
            let oauthHandled = false;
            
            const extractOAuthUrl = (output) => {
                const match = output.match(/https:\/\/console\.clever-cloud\.com\/cli-oauth\?[^\s]+/);
                return match ? match[0] : null;
            };
            
            const checkForSuccess = (output) => {
                const patterns = ['successfully logged in', 'Login successful', 'Logged in successfully', 'Token acquired'];
                return patterns.some(p => output.toLowerCase().includes(p.toLowerCase()));
            };
            
            dockerProcess.stdout.on('data', async (data) => {
                const output = data.toString();
                fs.appendFileSync(logFile, output);
                
                if (!oauthHandled && !dockerCompleted) {
                    const oauthUrl = extractOAuthUrl(output);
                    if (oauthUrl) {
                        oauthHandled = true;
                        await this.handleOAuth(oauthUrl, email, password);
                        await sleep(10000);
                    }
                }
                
                if (!dockerCompleted && checkForSuccess(output)) {
                    dockerCompleted = true;
                    this.completedAccounts.push({ email, password, completedAt: new Date() });
                    fs.appendFileSync(`accounts_${this.instanceId}.csv`, `${email},${password},${new Date().toISOString()}\n`);
                    resolve({ success: true, email });
                }
            });
            
            dockerProcess.stderr.on('data', (data) => {
                fs.appendFileSync(logFile, `[STDERR] ${data.toString()}`);
            });
            
            dockerProcess.on('close', (code) => {
                fs.appendFileSync(logFile, `\n--- EXITED WITH CODE ${code} ---\n`);
                const index = this.activeDockerProcesses.findIndex(p => p.id === dockerId);
                if (index !== -1) this.activeDockerProcesses.splice(index, 1);
                
                if (!dockerCompleted && oauthHandled) {
                    this.completedAccounts.push({ email, password, completedAt: new Date() });
                    fs.appendFileSync(`accounts_${this.instanceId}.csv`, `${email},${password},${new Date().toISOString()}\n`);
                    resolve({ success: true, email, warning: 'OAuth completed but no success message' });
                } else if (!dockerCompleted) {
                    reject(new Error(`Docker exited with code ${code}`));
                }
            });
            
            dockerProcess.unref();
            setTimeout(() => {
                if (!dockerCompleted) {
                    dockerCompleted = true;
                    reject(new Error('Docker timeout after 15 minutes'));
                    try { process.kill(dockerProcess.pid, 'SIGTERM'); } catch(e) {}
                }
            }, 900000);
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
        
        while (this.isRunning) {
            this.loopCount++;
            
            try {
                await this.waitForDockerSlot();
                log('START', `=== Loop #${this.loopCount} ===`, 'info', this.instanceId);
                await this.initBrowser();
                
                const email = await this.fetchTempEmail();
                await this.handleSignup(email, this.password);
                const verifyLink = await this.getVerificationLink();
                
                log('VERIFY', 'Activating account...', 'info', this.instanceId);
                await this.page.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await sleep(5000);
                
                await this.startDockerInBackground(email, this.password);
                log('FINISH', `Account ${email} created successfully!`, 'success', this.instanceId);
                
                await this.cleanup();
                this.consecutiveFailures = 0;
                
                log('WAIT', `Waiting ${this.waitAfterDockerMinutes} minutes before next cycle...`, 'warn', this.instanceId);
                await sleep(this.waitAfterDockerMinutes * 60 * 1000);
                
            } catch (e) {
                this.consecutiveFailures++;
                log('ERROR', `${e.message} (failure ${this.consecutiveFailures})`, 'error', this.instanceId);
                await this.cleanup();
                const backoff = Math.min(60000, 10000 * Math.pow(2, this.consecutiveFailures));
                await sleep(backoff);
            }
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
    activeDockerProcesses: 0,
    completedToday: 0,
    failedAttempts: 0,
    lastAccountCreated: null,
    currentLoopCount: 0,
    botStatus: 'starting',
    botInstance: null
};

function getTotalAccounts() {
    try {
        const files = fs.readdirSync('.');
        let total = 0;
        files.forEach(file => {
            if (file.startsWith('accounts_') && file.endsWith('.csv')) {
                const data = fs.readFileSync(file, 'utf8');
                total += data.trim().split('\n').length;
            }
        });
        return total;
    } catch (error) {
        return 0;
    }
}

function getTodayAccounts() {
    try {
        const files = fs.readdirSync('.');
        let today = 0;
        const todayStr = new Date().toISOString().split('T')[0];
        files.forEach(file => {
            if (file.startsWith('accounts_') && file.endsWith('.csv')) {
                const data = fs.readFileSync(file, 'utf8');
                const lines = data.trim().split('\n');
                lines.forEach(line => {
                    if (line.includes(todayStr)) today++;
                });
            }
        });
        return today;
    } catch (error) {
        return 0;
    }
}

function getDockerProcessCount() {
    try {
        const stdout = execSync('ps aux | grep "bash /app/docker" | grep -v grep | wc -l', { encoding: 'utf8' });
        return parseInt(stdout.trim());
    } catch (error) {
        return 0;
    }
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

// Start the bot
function startBot() {
    if (metrics.botInstance) {
        console.log('[SERVER] Bot already running');
        return;
    }
    
    console.log('[SERVER] Starting bot...');
    const bot = new CleverCloudBot('INSTANCE_1', 1, process.env.BOT_PASSWORD || 'Linuxdistro&84', 10);
    metrics.botInstance = bot;
    metrics.botStatus = 'running';
    metrics.startTime = new Date();
    
    // Update metrics periodically
    const interval = setInterval(() => {
        metrics.totalAccounts = getTotalAccounts();
        metrics.completedToday = getTodayAccounts();
        metrics.activeDockerProcesses = getDockerProcessCount();
        metrics.currentLoopCount = bot.loopCount;
    }, 10000);
    
    bot.run().catch(error => {
        console.error('[SERVER] Bot error:', error);
        metrics.botStatus = 'error';
    });
}

// ============ EXPRESS ROUTES ============
app.get('/api/metrics', (req, res) => {
    const systemMetrics = getSystemMetrics();
    const proxyStats = metrics.botInstance ? metrics.botInstance.proxyManager.getStats() : null;
    res.json({
        ...metrics,
        system: systemMetrics,
        proxy: proxyStats,
        useProxy: metrics.botInstance ? metrics.botInstance.useProxy : false,
        timestamp: new Date()
    });
});

app.get('/api/accounts', (req, res) => {
    try {
        const accounts = [];
        const files = fs.readdirSync('.');
        files.forEach(file => {
            if (file.startsWith('accounts_') && file.endsWith('.csv')) {
                const data = fs.readFileSync(file, 'utf8');
                const lines = data.trim().split('\n');
                lines.forEach(line => {
                    const [email, password, date] = line.split(',');
                    if (email && password) {
                        accounts.push({ email, password, date, instance: file.replace('accounts_', '').replace('.csv', '') });
                    }
                });
            }
        });
        res.json(accounts.reverse().slice(0, 100));
    } catch (error) {
        res.json([]);
    }
});

app.get('/api/proxy/stats', (req, res) => {
    if (metrics.botInstance && metrics.botInstance.proxyManager) {
        res.json(metrics.botInstance.proxyManager.getStats());
    } else {
        res.json({ error: 'Bot not initialized' });
    }
});

app.get('/api/proxy/refresh', async (req, res) => {
    if (metrics.botInstance && metrics.botInstance.proxyManager) {
        await metrics.botInstance.proxyManager.refreshProxies();
        res.json({ success: true, stats: metrics.botInstance.proxyManager.getStats() });
    } else {
        res.json({ error: 'Bot not initialized' });
    }
});

app.get('/api/logs', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const files = fs.readdirSync('.');
        const logFiles = files.filter(f => f.endsWith('.log')).sort().reverse();
        let logs = [];
        for (const file of logFiles.slice(0, 5)) {
            const data = fs.readFileSync(file, 'utf8');
            const lines = data.trim().split('\n').slice(-limit);
            logs.push({ file, lines });
        }
        res.json(logs);
    } catch (error) {
        res.json([]);
    }
});

// Dashboard HTML
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Clever Cloud Bot Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', sans-serif; background: #f5f5f5; color: #1e1e2f; }
        .container { max-width: 1400px; margin: 0 auto; padding: 24px; }
        .header { margin-bottom: 32px; }
        h1 { font-size: 28px; font-weight: 600; color: #1a1a2e; margin-bottom: 8px; }
        .subtitle { color: #666; font-size: 14px; }
        .card { background: white; border-radius: 16px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); margin-bottom: 24px; }
        .card-title { font-size: 16px; font-weight: 600; color: #333; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
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
        .log-entry { font-family: 'Monaco', monospace; font-size: 11px; padding: 4px 0; border-bottom: 1px solid #f0f0f0; color: #555; }
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
            <p class="subtitle">Real-time monitoring and metrics for your automation bot</p>
        </div>
        
        <div class="metrics-grid" id="metricsGrid">
            <div class="metric-card"><div class="metric-value" id="totalAccounts">0</div><div class="metric-label">Total Accounts</div></div>
            <div class="metric-card"><div class="metric-value" id="todayAccounts">0</div><div class="metric-label">Today's Accounts</div></div>
            <div class="metric-card"><div class="metric-value" id="dockerProcesses">0</div><div class="metric-label">Active Docker Processes</div></div>
            <div class="metric-card"><div class="metric-value" id="loopCount">0</div><div class="metric-label">Loop Count</div></div>
            <div class="metric-card"><div class="metric-value" id="failedAttempts">0</div><div class="metric-label">Failed Attempts</div></div>
            <div class="metric-card"><div class="metric-value" id="cpuUsage">0%</div><div class="metric-label">CPU Usage</div></div>
        </div>
        
        <div class="card">
            <div class="card-title">📊 System Status <div style="margin-left: auto;"><button class="refresh-btn" onclick="refreshData()">⟳ Refresh</button></div></div>
            <div class="status"><span class="status-dot" id="statusDot"></span><span id="botStatus">Loading...</span><span style="margin-left: 20px;">Started: <span id="startTime">-</span></span><span style="margin-left: 20px;">Uptime: <span id="uptime">-</span></span></div>
            <div id="proxyStats" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; color: #666;"></div>
        </div>
        
        <div class="card"><div class="card-title">📋 Recent Accounts</div><div class="table-responsive"><table id="accountsTable"><thead><tr><th>Email</th><th>Password</th><th>Date</th><th>Instance</th></tr></thead><tbody id="accountsBody"><tr><td colspan="4">Loading...</td></tr></tbody></table></div></div>
        <div class="card"><div class="card-title">📄 Recent Logs</div><div id="logsContainer">Loading...</div></div>
    </div>
    
    <script>
        async function fetchMetrics() {
            try {
                const res = await fetch('/api/metrics');
                const data = await res.json();
                
                document.getElementById('totalAccounts').textContent = data.totalAccounts || 0;
                document.getElementById('todayAccounts').textContent = data.completedToday || 0;
                document.getElementById('dockerProcesses').textContent = data.activeDockerProcesses || 0;
                document.getElementById('loopCount').textContent = data.currentLoopCount || 0;
                document.getElementById('failedAttempts').textContent = data.failedAttempts || 0;
                document.getElementById('cpuUsage').textContent = (data.system?.cpuUsage || 0) + '%';
                
                const statusDot = document.getElementById('statusDot');
                if (data.botStatus === 'running') { statusDot.className = 'status-dot'; document.getElementById('botStatus').textContent = 'Running'; }
                else { statusDot.className = 'status-dot stopped'; document.getElementById('botStatus').textContent = 'Stopped'; }
                
                document.getElementById('startTime').textContent = new Date(data.startTime).toLocaleString();
                if (data.system?.uptime) { const hours = Math.floor(data.system.uptime / 3600); const minutes = Math.floor((data.system.uptime % 3600) / 60); document.getElementById('uptime').textContent = hours + 'h ' + minutes + 'm'; }
                
                if (data.proxy) {
                    document.getElementById('proxyStats').innerHTML = \`🔐 Proxy: \${data.useProxy ? 'Enabled' : 'Disabled'} | Working Proxies: \${data.proxy.workingProxies} | Fastest: \${data.proxy.fastestProxy}\`;
                }
            } catch(e) { console.error(e); }
        }
        
        async function fetchAccounts() {
            try {
                const res = await fetch('/api/accounts');
                const accounts = await res.json();
                const tbody = document.getElementById('accountsBody');
                if (accounts.length === 0) { tbody.innerHTML = '<tr><td colspan="4">No accounts found</td></tr>'; return; }
                tbody.innerHTML = accounts.slice(0, 20).map(acc => \`<tr><td>\${acc.email}</td><td>\${acc.password}</td><td>\${new Date(acc.date).toLocaleString()}</td><td>\${acc.instance || '-'}</td></tr>\`).join('');
            } catch(e) { console.error(e); }
        }
        
        async function fetchLogs() {
            try {
                const res = await fetch('/api/logs');
                const logs = await res.json();
                const container = document.getElementById('logsContainer');
                if (logs.length === 0) { container.innerHTML = '<div>No logs found</div>'; return; }
                container.innerHTML = logs.map(log => \`<div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">📄 \${log.file}</div><div style="background: #f8f9fa; padding: 12px; border-radius: 8px; font-size: 11px; font-family: monospace; max-height: 200px; overflow-y: auto;">\${log.lines.map(line => '<div class="log-entry">' + escapeHtml(line.substring(0, 200)) + '</div>').join('')}</div></div>\`).join('');
            } catch(e) { console.error(e); }
        }
        
        function escapeHtml(text) { return text.replace(/[&<>]/g, function(m) { if (m === '&') return '&amp;'; if (m === '<') return '&lt;'; if (m === '>') return '&gt;'; return m; }); }
        async function refreshData() { await Promise.all([fetchMetrics(), fetchAccounts(), fetchLogs()]); }
        refreshData();
        setInterval(refreshData, 10000);
    </script>
</body>
</html>
    `);
});

// ============ START SERVER ============
console.log(`\n🚀 Clever Cloud Bot Dashboard Starting...\n`);
console.log(`📊 Dashboard available at: http://localhost:${port}`);
console.log(`📈 Metrics API: http://localhost:${port}/api/metrics`);
console.log(`📋 Accounts API: http://localhost:${port}/api/accounts`);
console.log(`📄 Logs API: http://localhost:${port}/api/logs`);
console.log(`🔐 Proxy Stats: http://localhost:${port}/api/proxy/stats\n`);

// Start the bot after 5 seconds
setTimeout(() => {
    startBot();
}, 5000);

// Start express server
app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Dashboard server running on port ${port}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    if (metrics.botInstance) {
        metrics.botInstance.stop();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...');
    if (metrics.botInstance) {
        metrics.botInstance.stop();
    }
    process.exit(0);
});
