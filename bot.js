const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { spawn } = require('child_process');
const fs = require('fs');
const colors = require('colors');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const http = require('http');

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

// Find real browser executable
function findRealBrowser() {
    // Priority order for real browsers (not snap stubs)
    const possiblePaths = [
        // Puppeteer's bundled Chromium (most reliable)
        '/app/node_modules/puppeteer/.local-chromium/linux-*/chrome-linux/chrome',
        '/app/node_modules/puppeteer-core/.local-chromium/linux-*/chrome-linux/chrome',
        // System Chrome
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        // System Chromium (real one, not snap)
        '/usr/lib/chromium/chromium',
        '/usr/lib/chromium-browser/chromium-browser',
        // Snap workaround - find the real snap mount
        '/snap/chromium/current/usr/lib/chromium-browser/chrome',
        '/snap/bin/chromium'
    ];
    
    for (const pattern of possiblePaths) {
        if (pattern.includes('*')) {
            // Handle wildcard patterns
            const glob = require('glob');
            const matches = glob.sync(pattern);
            if (matches.length > 0) {
                const realPath = matches[0];
                if (fs.existsSync(realPath) && fs.statSync(realPath).size > 1000000) {
                    console.log(`[SYSTEM] Found real browser: ${realPath}`.green);
                    return realPath;
                }
            }
        } else {
            if (fs.existsSync(pattern)) {
                const stats = fs.statSync(pattern);
                // Real browser is > 10MB, snap stub is tiny
                if (stats.size > 10000000) {
                    console.log(`[SYSTEM] Found real browser: ${pattern} (${(stats.size/1024/1024).toFixed(2)} MB)`.green);
                    return pattern;
                } else {
                    console.log(`[SYSTEM] Ignoring snap stub: ${pattern} (${stats.size} bytes)`.yellow);
                }
            }
        }
    }
    
    console.log('[SYSTEM] No real browser found, will use Puppeteer bundled Chromium'.yellow);
    return null;
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
        this.browserPath = null;
    }

    async getDockerProcessCount() {
        try {
            const { stdout } = await execPromise(`ps aux | grep "bash /docker" | grep "${this.instanceId}" | grep -v grep | wc -l`);
            const count = parseInt(stdout.trim());
            return count;
        } catch (error) {
            return 0;
        }
    }

    async getTotalDockerProcessCount() {
        try {
            const { stdout } = await execPromise('ps aux | grep "bash /docker" | grep -v grep | wc -l');
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
                const { stdout } = await execPromise(`ps aux | grep "bash /docker" | grep "${this.instanceId}" | grep -v grep`);
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
        log('SYSTEM', 'Launching browser...', 'info', this.instanceId);
        
        // Find real browser if not already found
        if (!this.browserPath) {
            this.browserPath = findRealBrowser();
        }
        
        const launchOptions = {
            headless: true,
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
        
        // Only set executable path if we found a real browser
        if (this.browserPath && this.browserPath !== 'bundled') {
            launchOptions.executablePath = this.browserPath;
            log('SYSTEM', `Using browser at: ${this.browserPath}`, 'success', this.instanceId);
        } else {
            log('SYSTEM', 'Using Puppeteer bundled Chromium', 'info', this.instanceId);
        }
        
        try {
            this.browser = await puppeteer.launch(launchOptions);
            
            this.page = await this.browser.newPage();
            await this.page.setViewport({ width: 1280, height: 800 });
            
            this.page.setDefaultTimeout(60000);
            this.page.setDefaultNavigationTimeout(60000);
            
            const version = await this.browser.version();
            log('SYSTEM', `Browser version: ${version}`, 'success', this.instanceId);
            
        } catch (error) {
            log('SYSTEM', `Failed to launch browser: ${error.message}`, 'error', this.instanceId);
            
            // Fallback: try without custom executable path
            if (launchOptions.executablePath) {
                log('SYSTEM', 'Retrying with Puppeteer bundled Chromium...', 'warn', this.instanceId);
                delete launchOptions.executablePath;
                this.browser = await puppeteer.launch(launchOptions);
                this.page = await this.browser.newPage();
                await this.page.setViewport({ width: 1280, height: 800 });
                this.page.setDefaultTimeout(60000);
                this.page.setDefaultNavigationTimeout(60000);
            } else {
                throw error;
            }
        }
    }

    // Rest of your existing methods (fetchTempEmail, handleSignup, getVerificationLink, handleOAuth, startDockerInBackground, cleanup, waitAfterDockerCompletion, run, stop)
    // ... keep all your existing methods exactly as they were ...
    
    // I'm omitting the rest of the methods for brevity, but keep ALL your existing code here
    // The only changes are in the browser initialization section above
}

// Health check server for Scalingo
const isScalingo = process.env.SCALINGO || process.env.CONTAINER === 'scalingo' || process.env.NODE_ENV === 'production';

if (isScalingo) {
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

// InstanceManager and main function remain the same...
// Keep ALL your existing code after this point
