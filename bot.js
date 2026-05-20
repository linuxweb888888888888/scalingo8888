const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const colors = require('colors');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const https = require('https');
const { createWriteStream } = require('fs');

// Apply stealth plugin
puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(step, message, type = 'info', instanceId = 'MAIN') {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = `[${timestamp}] [${instanceId}] [${step}]`.bold;
    if (type === 'success') console.log(`${prefix} ${'✔'.green} ${message.green}`);
    else if (type === 'error') console.log(`${prefix} ${'✘'.red} ${message.red}`);
    else if (type === 'warn') console.log(`${prefix} ${'!'.yellow} ${message.yellow}`);
    else console.log(`${prefix} ${'ℹ'.cyan} ${message.white}`);
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
            const version = execSync(`${chromePath} --version`, { encoding: 'utf8' });
            log('SYSTEM', `Chromium version: ${version.trim()}`, 'success', 'MAIN');
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

class CleverCloudBot {
    constructor(instanceId, maxConcurrent, password, startDelay = 0) {
        this.instanceId = instanceId;
        this.browser = null;
        this.page = null;
        this.mailPage = null;
        this.realTempEmail = null;
        this.dockerLogFile = `docker_output_${instanceId}.log`;
        this.currentChild = null;
        this.activeDockerProcesses = [];
        this.completedAccounts = [];
        this.maxConcurrentDocker = maxConcurrent;
        this.password = password;
        this.startDelay = startDelay;
        this.isRunning = true;
        this.loopCount = 0;
        this.consecutiveFailures = 0;
        this.waitAfterDockerMinutes = parseInt(process.env.BOT_WAIT_MINUTES) || 5;
        this.oauthUrl = null;
        this.chromePath = null;
    }

    async getDockerProcessCount() {
        try {
            const { stdout } = await execPromise(`ps aux | grep "bash /app/docker" | grep "${this.instanceId}" | grep -v grep | wc -l`);
            const count = parseInt(stdout.trim());
            return count;
        } catch (error) {
            return 0;
        }
    }

    async getTotalDockerProcessCount() {
        try {
            const { stdout } = await execPromise('ps aux | grep "bash /app/docker" | grep -v grep | wc -l');
            const count = parseInt(stdout.trim());
            return count;
        } catch (error) {
            return 0;
        }
    }

    async showDockerStatus() {
        const myCount = await this.getDockerProcessCount();
        const totalCount = await this.getTotalDockerProcessCount();
        
        console.log(`\n${'═'.repeat(60)}`);
        console.log(` INSTANCE ${this.instanceId} DOCKER STATUS `.cyan.bold);
        console.log(`${'═'.repeat(60)}`);
        console.log(`  My Docker processes: ${myCount.toString().yellow}`);
        console.log(`  Total Docker processes (all instances): ${totalCount.toString().cyan}`);
        console.log(`  Max concurrent allowed (this instance): ${this.maxConcurrentDocker.toString().green}`);
        console.log(`  Completed accounts (this instance): ${this.completedAccounts.length.toString().green}`);
        console.log(`  Loop count: ${this.loopCount}`);
        console.log(`  Wait after Docker: ${this.waitAfterDockerMinutes} minutes`);
        console.log(`${'═'.repeat(60)}\n`);
        
        if (myCount > 0) {
            try {
                const { stdout } = await execPromise(`ps aux | grep "bash /app/docker" | grep "${this.instanceId}" | grep -v grep`);
                const lines = stdout.trim().split('\n');
                console.log(`  Running Docker instances (Instance ${this.instanceId}):`.yellow);
                lines.forEach((line, index) => {
                    const parts = line.split(/\s+/);
                    const pid = parts[1];
                    const cpu = parts[2];
                    const mem = parts[3];
                    console.log(`    ${(index + 1).toString().gray}) PID: ${pid?.yellow} | CPU: ${cpu?.cyan}% | MEM: ${mem?.cyan}%`);
                });
                console.log('');
            } catch (e) {}
        }
        
        return myCount;
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
                    process.stdout.write(`\n  ${i}s `.cyan);
                } else {
                    process.stdout.write('.'.cyan);
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

                process.stdout.write('.'.white);
                await sleep(5000);
                
            } catch (error) {
                await sleep(5000);
            }
        }
    }

    async handleOAuth(url, email, password) {
        log('OAUTH', `Opening OAuth URL...`, 'info', this.instanceId);
        log('OAUTH', `URL: ${url.substring(0, 100)}...`, 'info', this.instanceId);
        
        try {
            const oauthPage = await this.browser.newPage();
            
            await oauthPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            
            log('OAUTH', 'OAuth page loaded, looking for login form...', 'info', this.instanceId);
            
            await sleep(5000);
            
            // Auto-fill email and password
            const credentialsFilled = await oauthPage.evaluate((email, password) => {
                const emailSelectors = [
                    'input[type="email"]',
                    'input[name="email"]',
                    'input[id="email"]',
                    'input[placeholder*="email"]',
                    'input[placeholder*="Email"]'
                ];
                
                const passwordSelectors = [
                    'input[type="password"]',
                    'input[name="password"]',
                    'input[id="password"]',
                    'input[placeholder*="password"]',
                    'input[placeholder*="Password"]'
                ];
                
                let emailField = null;
                let passwordField = null;
                
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
                    emailField.dispatchEvent(new Event('change', { bubbles: true }));
                    passwordField.dispatchEvent(new Event('input', { bubbles: true }));
                    passwordField.dispatchEvent(new Event('change', { bubbles: true }));
                    
                    return true;
                }
                return false;
            }, email, password);
            
            if (credentialsFilled) {
                log('OAUTH', 'Credentials filled successfully', 'success', this.instanceId);
                await sleep(2000);
                
                const loginClicked = await oauthPage.evaluate(() => {
                    const buttonSelectors = [
                        'button[type="submit"]',
                        'input[type="submit"]',
                        '.btn-primary',
                        '.btn-login',
                        'button[class*="login"]',
                        '#login-button'
                    ];
                    
                    const allButtons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                    const loginButton = allButtons.find(btn => {
                        const text = (btn.innerText || btn.value || '').toLowerCase();
                        return text.includes('login') || 
                               text.includes('sign in') || 
                               text.includes('log in') ||
                               text.includes('continue') ||
                               text.includes('submit');
                    });
                    
                    if (loginButton) {
                        loginButton.click();
                        return true;
                    }
                    
                    const form = document.querySelector('form');
                    if (form) {
                        form.submit();
                        return true;
                    }
                    
                    return false;
                });
                
                if (loginClicked) {
                    log('OAUTH', 'Login button clicked!', 'success', this.instanceId);
                } else {
                    log('OAUTH', 'Could not find login button', 'warn', this.instanceId);
                }
            } else {
                log('OAUTH', 'Could not find email/password fields', 'warn', this.instanceId);
            }
            
            await sleep(8000);
            
            const currentUrl = oauthPage.url();
            log('OAUTH', `Final URL: ${currentUrl}`, 'info', this.instanceId);
            
            await oauthPage.close();
            log('OAUTH', 'OAuth flow completed', 'success', this.instanceId);
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
                log('DOCKER', `Docker script not found at ${dockerScriptPath}`, 'error', this.instanceId);
                reject(new Error('Docker script not found'));
                return;
            }
            
            try {
                fs.chmodSync(dockerScriptPath, 0o755);
            } catch (e) {}
            
            // Removed source ~/.nvm/nvm.sh - not needed on Scalingo
            const cmd = `bash ${dockerScriptPath} webwebwebweb8888 3 start buyrunplace --instance ${this.instanceId}`;
            
            log('DOCKER', `Executing: ${cmd}`, 'info', this.instanceId);
            
            const dockerProcess = spawn('bash', ['-c', cmd], {
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            const processInfo = {
                id: dockerId,
                process: dockerProcess,
                email: email,
                startTime: new Date(),
                logFile: logFile,
                pid: dockerProcess.pid
            };
            
            this.activeDockerProcesses.push(processInfo);
            
            fs.writeFileSync(logFile, `--- DOCKER SESSION: ${new Date().toLocaleString()} ---\n`);
            fs.appendFileSync(logFile, `Instance: ${this.instanceId}\nEmail: ${email}\nPassword: ${password}\nPID: ${dockerProcess.pid}\nCommand: ${cmd}\n\n`);
            
            let dockerCompleted = false;
            let outputBuffer = '';
            let oauthHandled = false;
            
            const extractOAuthUrl = (output) => {
                const urlPattern = /https:\/\/console\.clever-cloud\.com\/cli-oauth\?[^\s]+/;
                const match = output.match(urlPattern);
                return match ? match[0] : null;
            };
            
            const checkForSuccess = (output) => {
                const successPatterns = [
                    'successfully logged in',
                    'Login successful',
                    'Authentication successful',
                    'Logged in successfully',
                    'Welcome',
                    'Session created',
                    'Token acquired',
                    'Deployment successful'
                ];
                
                for (const pattern of successPatterns) {
                    if (output.toLowerCase().includes(pattern.toLowerCase())) {
                        return true;
                    }
                }
                return false;
            };
            
            dockerProcess.stdout.on('data', async (data) => {
                const output = data.toString();
                outputBuffer += output;
                fs.appendFileSync(logFile, output);
                
                const lines = output.split('\n');
                for (const line of lines) {
                    if (line.trim()) {
                        if (line.toLowerCase().includes('error')) {
                            log('DOCKER', `ERR: ${line.substring(0, 200)}`, 'error', this.instanceId);
                        } else if (checkForSuccess(line)) {
                            log('DOCKER', `SUCCESS: ${line.substring(0, 200)}`, 'success', this.instanceId);
                        } else {
                            log('DOCKER', `OUT: ${line.substring(0, 200)}`, 'info', this.instanceId);
                        }
                    }
                }
                
                if (!oauthHandled && !dockerCompleted) {
                    const oauthUrl = extractOAuthUrl(output);
                    if (oauthUrl) {
                        oauthHandled = true;
                        log('OAUTH', 'Found OAuth URL, handling...', 'success', this.instanceId);
                        
                        try {
                            await this.handleOAuth(oauthUrl, email, password);
                            await sleep(10000);
                        } catch (oauthError) {
                            log('OAUTH', `OAuth failed: ${oauthError.message}`, 'error', this.instanceId);
                        }
                    }
                }
                
                if (!dockerCompleted && checkForSuccess(output)) {
                    dockerCompleted = true;
                    log('DOCKER', `✓ Login successful for ${email}!`, 'success', this.instanceId);
                    
                    const index = this.activeDockerProcesses.findIndex(p => p.id === dockerId);
                    if (index !== -1) {
                        this.activeDockerProcesses.splice(index, 1);
                        this.completedAccounts.push({ email, password, completedAt: new Date() });
                        fs.appendFileSync(`accounts_${this.instanceId}.csv`, `${email},${password},${new Date().toISOString()}\n`);
                    }
                    
                    resolve({ success: true, email: email });
                }
            });
            
            dockerProcess.stderr.on('data', (data) => {
                const err = data.toString();
                fs.appendFileSync(logFile, `[STDERR] ${err}`);
                if (err.toLowerCase().includes('error')) {
                    log('DOCKER', `STDERR: ${err.substring(0, 200)}`, 'error', this.instanceId);
                }
            });
            
            dockerProcess.on('close', (code) => {
                fs.appendFileSync(logFile, `\n--- PROCESS EXITED WITH CODE ${code} ---\n`);
                fs.appendFileSync(logFile, `--- Last 1000 chars of output: ---\n${outputBuffer.slice(-1000)}\n`);
                
                const index = this.activeDockerProcesses.findIndex(p => p.id === dockerId);
                if (index !== -1) {
                    this.activeDockerProcesses.splice(index, 1);
                }
                
                if (!dockerCompleted && code === 0) {
                    if (oauthHandled) {
                        log('DOCKER', `OAuth was handled, assuming success`, 'success', this.instanceId);
                        this.completedAccounts.push({ email, password, completedAt: new Date() });
                        fs.appendFileSync(`accounts_${this.instanceId}.csv`, `${email},${password},${new Date().toISOString()}\n`);
                        resolve({ success: true, email: email });
                    } else {
                        reject(new Error(`Docker exited with code ${code} without success`));
                    }
                } else if (!dockerCompleted) {
                    reject(new Error(`Docker exited with code ${code}`));
                }
            });
            
            dockerProcess.on('error', (error) => {
                log('DOCKER', `Process error: ${error.message}`, 'error', this.instanceId);
                if (!dockerCompleted) {
                    dockerCompleted = true;
                    reject(new Error(`Docker process error: ${error.message}`));
                }
            });
            
            dockerProcess.unref();
            
            setTimeout(() => {
                if (!dockerCompleted) {
                    dockerCompleted = true;
                    log('DOCKER', `Process timeout after 15 minutes`, 'error', this.instanceId);
                    reject(new Error('Docker timeout after 15 minutes'));
                    try {
                        process.kill(dockerProcess.pid, 'SIGTERM');
                    } catch (e) {}
                }
            }, 900000);
        });
    }

    async cleanup() {
        if (this.browser) {
            await this.browser.close();
        }
    }

    async cleanupAllDocker() {
        for (const proc of this.activeDockerProcesses) {
            try {
                process.kill(proc.pid, 'SIGTERM');
            } catch (e) {}
        }
    }

    async waitAfterDockerCompletion() {
        const waitMs = this.waitAfterDockerMinutes * 60 * 1000;
        const waitMinutes = this.waitAfterDockerMinutes;
        
        log('WAIT', `========================================`, 'info', this.instanceId);
        log('WAIT', `⏰ Waiting ${waitMinutes} minutes before next cycle...`, 'warn', this.instanceId);
        log('WAIT', `========================================`, 'info', this.instanceId);
        
        const startTime = Date.now();
        const endTime = startTime + waitMs;
        
        while (Date.now() < endTime && this.isRunning) {
            const remaining = endTime - Date.now();
            const remainingMinutes = Math.floor(remaining / 60000);
            const remainingSeconds = Math.floor((remaining % 60000) / 1000);
            
            if (remaining % 30000 < 1000) {
                log('WAIT', `Remaining: ${remainingMinutes}m ${remainingSeconds}s`, 'info', this.instanceId);
            }
            await sleep(1000);
        }
        
        log('WAIT', `✅ Wait period complete! Resuming...`, 'success', this.instanceId);
    }

    async run() {
        if (this.startDelay > 0) {
            log('START', `Waiting ${this.startDelay} seconds...`, 'warn', this.instanceId);
            await sleep(this.startDelay * 1000);
        }
        
        log('START', `=== Instance ${this.instanceId} Starting ===`, 'info', this.instanceId);
        
        const statusInterval = setInterval(() => {
            if (this.isRunning) {
                this.showDockerStatus();
            }
        }, 60000);
        
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
                
                const result = await this.startDockerInBackground(email, this.password);
                
                if (result.warning) {
                    log('FINISH', `Account ${email} created but with warning: ${result.warning}`, 'warn', this.instanceId);
                } else {
                    log('FINISH', `Account ${email} created successfully!`, 'success', this.instanceId);
                }
                
                await this.cleanup();
                this.consecutiveFailures = 0;
                
                await this.waitAfterDockerCompletion();
                
            } catch (e) {
                this.consecutiveFailures++;
                log('ERROR', `${e.message} (failure ${this.consecutiveFailures})`, 'error', this.instanceId);
                await this.cleanup();
                
                const backoff = Math.min(60000, 10000 * Math.pow(2, this.consecutiveFailures));
                log('RESTART', `Waiting ${backoff/1000}s...`, 'warn', this.instanceId);
                await sleep(backoff);
            }
        }
        
        clearInterval(statusInterval);
    }

    stop() {
        this.isRunning = false;
    }
}

// Health check server for Scalingo
const isScalingo = process.env.SCALINGO || process.env.CONTAINER === 'scalingo' || process.env.NODE_ENV === 'production';

if (isScalingo) {
    const http = require('http');
    const server = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('OK');
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    
    const port = process.env.PORT || 3000;
    server.listen(port, '0.0.0.0', () => {
        console.log(`[SYSTEM] Health check server listening on port ${port}`.green);
        console.log(`[SYSTEM] Bot is starting up...`.cyan);
    });
}

class InstanceManager {
    constructor() {
        this.bots = [];
        this.isShuttingDown = false;
    }

    async startInstances(config) {
        const {
            instances: instanceCount = parseInt(process.env.BOT_INSTANCES) || 1,
            baseId = process.env.BOT_BASE_ID || 'INSTANCE',
            maxConcurrent = parseInt(process.env.BOT_MAX_CONCURRENT) || 1,
            password = process.env.BOT_PASSWORD || 'Linuxdistro&84',
            startDelay = parseInt(process.env.BOT_START_DELAY) || 10,
            delayBetweenInstances = parseInt(process.env.BOT_DELAY_BETWEEN) || 15,
            waitAfterDocker = parseInt(process.env.BOT_WAIT_MINUTES) || 5
        } = config;

        console.log('\n' + '='.repeat(70));
        console.log(' CLEVER CLOUD BOT STARTING '.yellow.bold);
        console.log('='.repeat(70));
        console.log(`  Instances: ${instanceCount}`);
        console.log(`  Max concurrent: ${maxConcurrent}`);
        console.log(`  Wait after Docker: ${waitAfterDocker} minutes`.green);
        console.log(`  Environment: ${isScalingo ? 'Scalingo (Production)' : 'Local'}`);
        console.log('='.repeat(70) + '\n');

        for (let i = 1; i <= instanceCount; i++) {
            const instanceId = `${baseId}_${i}`;
            const instanceStartDelay = startDelay + (i - 1) * delayBetweenInstances;
            
            console.log(`[MANAGER] Starting ${instanceId}...`);
            
            const bot = new CleverCloudBot(
                instanceId,
                maxConcurrent,
                password,
                instanceStartDelay
            );
            
            bot.waitAfterDockerMinutes = waitAfterDocker;
            this.bots.push(bot);
            
            this.runBot(bot).catch(error => {
                console.error(`[${instanceId}] Fatal error:`, error);
            });
            
            if (i < instanceCount) {
                await sleep(delayBetweenInstances * 1000);
            }
        }
        
        console.log(`\n[MANAGER] All ${instanceCount} instances started!`);
        console.log(`[MANAGER] Bot is running. Press Ctrl+C to stop.\n`);
        
        this.setupGracefulShutdown();
    }
    
    async runBot(bot) {
        try {
            await bot.run();
        } catch (error) {
            console.error(`[${bot.instanceId}] Bot error:`, error);
        }
    }
    
    setupGracefulShutdown() {
        const shutdownHandler = async () => {
            if (this.isShuttingDown) return;
            this.isShuttingDown = true;
            
            console.log('\n' + '='.repeat(70).red);
            console.log(' SHUTTING DOWN... '.red.bold);
            console.log('='.repeat(70).red);
            
            const stopPromises = this.bots.map(async (bot) => {
                console.log(`Stopping ${bot.instanceId}...`);
                bot.stop();
                await bot.cleanupAllDocker();
                await bot.cleanup();
            });
            
            await Promise.all(stopPromises);
            console.log('[MANAGER] All instances stopped. Goodbye!'.yellow);
            process.exit(0);
        };
        
        process.on('SIGINT', shutdownHandler);
        process.on('SIGTERM', shutdownHandler);
    }
}

function parseArgs() {
    const args = process.argv.slice(2);
    const params = {
        instances: parseInt(process.env.BOT_INSTANCES) || 1,
        baseId: process.env.BOT_BASE_ID || 'INSTANCE',
        maxConcurrent: parseInt(process.env.BOT_MAX_CONCURRENT) || 1,
        password: process.env.BOT_PASSWORD || 'Linuxdistro&84',
        startDelay: parseInt(process.env.BOT_START_DELAY) || 10,
        delayBetweenInstances: parseInt(process.env.BOT_DELAY_BETWEEN) || 15,
        waitAfterDocker: parseInt(process.env.BOT_WAIT_MINUTES) || 5
    };
    
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--instances':
            case '-n':
                if (args[i + 1] && !args[i + 1].startsWith('-')) {
                    params.instances = parseInt(args[++i]);
                }
                break;
            case '--wait':
            case '-w':
                if (args[i + 1] && !args[i + 1].startsWith('-')) {
                    params.waitAfterDocker = parseInt(args[++i]);
                }
                break;
            case '--help':
            case '-h':
                console.log(`
Clever Cloud Bot - Scalingo Deployment

Features:
  ✓ Automatic account creation with temporary email
  ✓ Auto-fills email and password on OAuth page
  ✓ Automatically clicks login button
  ✓ Handles Docker deployment
  ✓ Waits 5 minutes between accounts

Usage: node bot.js [options]

Options:
  --instances, -n <number>     Number of instances (default: 1)
  --wait, -w <minutes>         Wait time after Docker (default: 5)
  --help, -h                   Show this help

Environment Variables:
  BOT_INSTANCES                Number of instances
  BOT_PASSWORD                 Default password
  BOT_WAIT_MINUTES             Wait time in minutes
  PORT                         Health check port (default: 3000)
                `);
                process.exit(0);
                break;
        }
    }
    
    return params;
}

async function main() {
    console.log(`\n🚀 Clever Cloud Bot Starting on Scalingo...\n`);
    
    const config = parseArgs();
    const manager = new InstanceManager();
    
    await manager.startInstances(config);
}

main().catch(console.error);
