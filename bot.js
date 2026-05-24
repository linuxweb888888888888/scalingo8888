const express = require('express');
const fs = require('fs');
const os = require('os');
const { execSync, spawn } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const { createWriteStream } = require('fs');
const { MongoClient } = require('mongodb');

// Apply stealth plugin for maximum anonymity
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;

// ============ RANDOM USER AGENT POOL (Updated 2026) ============
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:149.0) Gecko/20100101 Firefox/149.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
];

// ============ RANDOM VIEWPORT SIZES ============
const VIEWPORTS = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 375, height: 812, isMobile: true, hasTouch: true },
    { width: 390, height: 844, isMobile: true, hasTouch: true },
    { width: 414, height: 896, isMobile: true, hasTouch: true },
];

// ============ RANDOM LOCALES ============
const LOCALES = ['en-US', 'en-GB', 'en-CA', 'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'ja-JP'];

// ============ RANDOM TIMEZONES ============
const TIMEZONES = [
    'America/New_York', 'America/Los_Angeles', 'America/Chicago', 'America/Denver',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
    'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Australia/Sydney',
    'UTC', 'Etc/GMT', 'Etc/GMT+1', 'Etc/GMT-1'
];

// ============ RANDOM PLATFORMS ============
const PLATFORMS = ['Win32', 'MacIntel', 'Linux x86_64', 'iPhone', 'iPad'];

// ============ RANDOM LANGUAGES ============
const LANGUAGES = [
    ['en-US', 'en'],
    ['en-GB', 'en'],
    ['fr-FR', 'fr'],
    ['de-DE', 'de'],
    ['es-ES', 'es'],
    ['it-IT', 'it'],
    ['ja-JP', 'ja'],
    ['zh-CN', 'zh'],
];

// ============ PROXY LIST (Optional - for IP spoofing) ============
// Note: You need to obtain working proxies from providers like:
// - Residential proxies
// - Datacenter proxies  
// - Rotating proxies
const PROXY_LIST = [
    // Format: 'http://username:password@ip:port'
    // Or: 'socks5://ip:port'
    // Add your actual proxies here
    // 'http://user:pass@192.168.1.1:8080',
    // 'socks5://192.168.1.2:1080',
];

// ============ HELPER FUNCTIONS ============
const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Generate random screen resolution
function getRandomScreenResolution() {
    const viewport = randomItem(VIEWPORTS);
    return {
        width: viewport.width,
        height: viewport.height,
        availWidth: viewport.width,
        availHeight: viewport.height,
        colorDepth: randomInt(24, 32),
        pixelDepth: randomInt(24, 32)
    };
}

// Generate random WebGL vendor/renderer
function getRandomWebGL() {
    const vendors = [
        { vendor: 'Google Inc.', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)' },
        { vendor: 'Google Inc.', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0)' },
        { vendor: 'Google Inc.', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)' },
        { vendor: 'Intel Inc.', renderer: 'Intel Iris OpenGL Engine' },
        { vendor: 'NVIDIA Corporation', renderer: 'NVIDIA GeForce RTX 3060 OpenGL Engine' },
    ];
    return randomItem(vendors);
}

// Generate random canvas fingerprint
function getRandomCanvasFingerprint() {
    const fingerprints = [
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...',
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAB...',
    ];
    return randomItem(fingerprints);
}

// ============ IP SPOOFING WITH PROXY ============
async function getRandomProxy() {
    if (PROXY_LIST.length === 0) {
        return null;
    }
    return randomItem(PROXY_LIST);
}

// ============ HIGH ANONYMITY BROWSER LAUNCH ============
async function launchStealthBrowser() {
    const randomUserAgent = randomItem(USER_AGENTS);
    const randomViewport = randomItem(VIEWPORTS);
    const randomLocale = randomItem(LOCALES);
    const randomTimezone = randomItem(TIMEZONES);
    const randomPlatform = randomItem(PLATFORMS);
    const randomLanguages = randomItem(LANGUAGES);
    const screenResolution = getRandomScreenResolution();
    const webgl = getRandomWebGL();
    
    // Determine if platform is mobile
    const isMobile = randomPlatform === 'iPhone' || randomPlatform === 'iPad';
    
    // Build browser arguments for maximum anonymity
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-web-security',
        `--lang=${randomLocale}`,
        `--timezone=${randomTimezone}`,
        `--window-size=${randomViewport.width},${randomViewport.height}`,
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process,ChromeWhatsNewUI',
        '--disable-features=OptimizationGuideModelDownloading',
        '--disable-features=OptimizationHintsFetching',
        '--disable-component-update',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-client-side-phishing-detection',
        '--disable-crash-reporter',
        '--disable-logging',
        '--disable-notifications',
        '--disable-password-manager-reauthentication',
        '--disable-permissions-api',
        '--no-default-browser-check',
        '--no-first-run',
        '--no-pings',
        '--no-sandbox',
        '--disable-sync',
        '--disable-domain-reliability',
        '--disable-breakpad',
        '--disable-crash-reporter',
        '--disable-component-extensions-with-background-pages',
        '--disable-datasaver-prompt',
        '--disable-desktop-notifications',
        '--disable-features=AudioServiceOutOfProcess',
        '--disable-features=CertificateTransparencyComponentUpdater',
        '--disable-features=ChromeWhatsNewUI',
        '--disable-features=HttpsUpgrades',
        '--disable-features=PasswordImport',
        '--disable-features=PrivacySandboxSettings4',
        '--disable-features=ProcessPerSiteUpToMainFrameThreshold',
        '--disable-features=SafeBrowsingOnUIThread',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-search-engine-choice-screen',
        '--disable-speech-api',
        '--disable-sync-preferences',
        '--disable-webgl-image-chromium',
        '--disable-webgl2-compute-context',
        '--disk-cache-size=0',
        '--dns-prefetch-disable',
        '--hide-scrollbars',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--ignore-ssl-errors',
        '--mute-audio',
        '--no-cache',
        '--no-zygote',
        '--silent-debugger-extension-api',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--window-position=0,0',
    ];
    
    // Add proxy if available
    const proxy = await getRandomProxy();
    if (proxy) {
        args.push(`--proxy-server=${proxy}`);
        console.log('[Proxy] Using proxy:', proxy);
    }
    
    // Launch browser with stealth arguments
    const browser = await puppeteer.launch({
        headless: ENV.HEADLESS_MODE,
        executablePath: ENV.CHROMIUM_PATH,
        args: args,
        ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
    });
    
    const page = await browser.newPage();
    
    // ============ SPOOF ALL WEB APIs ============
    
    // 1. Spoof User Agent
    await page.setUserAgent(randomUserAgent);
    
    // 2. Spoof Viewport
    await page.setViewport(randomViewport);
    
    // 3. Spoof JavaScript properties
    await page.evaluateOnNewDocument((userAgent, platform, languages, webgl, timezone, screen, locale) => {
        // Override navigator properties
        Object.defineProperty(navigator, 'userAgent', {
            get: () => userAgent,
            configurable: false,
        });
        
        Object.defineProperty(navigator, 'platform', {
            get: () => platform,
            configurable: false,
        });
        
        Object.defineProperty(navigator, 'language', {
            get: () => languages[0],
            configurable: false,
        });
        
        Object.defineProperty(navigator, 'languages', {
            get: () => languages,
            configurable: false,
        });
        
        // Spoof plugins length (real browsers have plugins)
        Object.defineProperty(navigator, 'plugins', {
            get: () => {
                const plugins = [
                    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                    { name: 'Native Client', filename: 'internal-nacl-plugin' },
                ];
                plugins.length = plugins.length;
                return plugins;
            },
            configurable: false,
        });
        
        // Spoof webdriver (should be undefined)
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
            configurable: false,
        });
        
        // Spoof chrome object
        window.chrome = {
            runtime: {},
            loadTimes: function() {},
            csi: function() {},
            app: {},
        };
        
        // Spoof permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => {
            if (parameters.name === 'notifications') {
                return Promise.resolve({ state: Notification.permission });
            }
            return originalQuery(parameters);
        };
        
        // Spoof WebGL vendor and renderer
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) { // VENDOR
                return webgl.vendor;
            }
            if (parameter === 37446) { // RENDERER
                return webgl.renderer;
            }
            return getParameter(parameter);
        };
        
        // Spoof canvas fingerprint
        const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
            const result = originalToDataURL.apply(this, arguments);
            // Add slight noise to canvas
            if (type === 'image/png') {
                return result;
            }
            return result;
        };
        
        // Spoof timezone
        const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
        Date.prototype.getTimezoneOffset = function() {
            const timezoneOffsets = {
                'America/New_York': 300,
                'America/Los_Angeles': 480,
                'Europe/London': 0,
                'Europe/Paris': -60,
                'Asia/Tokyo': -540,
            };
            return timezoneOffsets[timezone] || originalGetTimezoneOffset.call(this);
        };
        
        // Spoof screen resolution
        Object.defineProperty(screen, 'width', {
            get: () => screen.width,
            configurable: false,
        });
        Object.defineProperty(screen, 'height', {
            get: () => screen.height,
            configurable: false,
        });
        Object.defineProperty(screen, 'availWidth', {
            get: () => screen.availWidth,
            configurable: false,
        });
        Object.defineProperty(screen, 'availHeight', {
            get: () => screen.availHeight,
            configurable: false,
        });
        Object.defineProperty(screen, 'colorDepth', {
            get: () => 24,
            configurable: false,
        });
        Object.defineProperty(screen, 'pixelDepth', {
            get: () => 24,
            configurable: false,
        });
        
        // Spoof hardware concurrency
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            get: () => Math.floor(Math.random() * (16 - 2 + 1) + 2),
            configurable: false,
        });
        
        // Spoof device memory
        Object.defineProperty(navigator, 'deviceMemory', {
            get: () => Math.floor(Math.random() * (8 - 2 + 1) + 2),
            configurable: false,
        });
        
        // Spoof max touch points
        Object.defineProperty(navigator, 'maxTouchPoints', {
            get: () => isMobile ? 5 : 0,
            configurable: false,
        });
        
        // Remove phantomjs, puppeteer traces
        delete window.__webdriver_evaluate;
        delete window.__selenium_evaluate;
        delete window.__webdriver_script_function;
        delete window.__webdriver_script_func;
        delete window.__webdriver_script_fn;
        delete window.__fxdriver_evaluate;
        delete window.__driver_unwrapped;
        delete window.__webdriver_unwrapped;
        delete window.__webdriver_wrapped;
        delete window.__webdriver_script_func;
        delete window.__webdriver_script_function;
        delete window.__phantom;
        delete window.__nightmare;
        delete window._phantom;
        delete window.callPhantom;
        
        // Spoof connection type
        Object.defineProperty(navigator, 'connection', {
            get: () => ({
                effectiveType: ['slow-2g', '2g', '3g', '4g'][Math.floor(Math.random() * 4)],
                rtt: Math.floor(Math.random() * (300 - 50 + 1) + 50),
                downlink: Math.floor(Math.random() * (10 - 1 + 1) + 1),
                saveData: false,
            }),
            configurable: false,
        });
        
        // Spoof battery API (deprecated but some sites still use)
        if (navigator.getBattery) {
            navigator.getBattery = function() {
                return Promise.resolve({
                    charging: Math.random() > 0.5,
                    chargingTime: Math.floor(Math.random() * 3600),
                    dischargingTime: Math.floor(Math.random() * 7200),
                    level: Math.random(),
                });
            };
        }
        
    }, randomUserAgent, randomPlatform, randomLanguages, webgl, randomTimezone, screenResolution, randomLocale);
    
    // Log the spoofed fingerprint
    console.log('[Fingerprint] User Agent:', randomUserAgent);
    console.log('[Fingerprint] Platform:', randomPlatform);
    console.log('[Fingerprint] Viewport:', randomViewport.width, 'x', randomViewport.height);
    console.log('[Fingerprint] Timezone:', randomTimezone);
    console.log('[Fingerprint] Locale:', randomLocale);
    console.log('[Fingerprint] Languages:', randomLanguages);
    console.log('[Fingerprint] WebGL:', webgl.vendor, '-', webgl.renderer);
    if (proxy) console.log('[Fingerprint] Proxy:', proxy);
    
    return { browser, page, fingerprint: { userAgent: randomUserAgent, viewport: randomViewport, platform: randomPlatform, timezone: randomTimezone } };
}

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

// ============ UPDATED BOT CLASS WITH STEALTH ============
class CleverCloudBot {
    constructor(instanceId) {
        this.instanceId = instanceId;
        this.browser = null;
        this.page = null;
        this.mailPage = null;
        this.realTempEmail = null;
        this.chromePath = null;
        this.oauthHandled = false;
        this.currentFingerprint = null;
    }

    async initBrowser() {
        if (!this.chromePath) {
            this.chromePath = await installChromiumRuntime();
        }
        if (!this.chromePath) throw new Error('No Chromium found');
        
        // Use high-anonymity launcher
        const { browser, page, fingerprint } = await launchStealthBrowser();
        this.browser = browser;
        this.page = page;
        this.currentFingerprint = fingerprint;
        
        log('STEALTH', 'Browser launched with spoofed fingerprint', 'info', this.instanceId);
        log('STEALTH', `User Agent: ${fingerprint.userAgent}`, 'info', this.instanceId);
        log('STEALTH', `Viewport: ${fingerprint.viewport.width}x${fingerprint.viewport.height}`, 'info', this.instanceId);
        log('STEALTH', `Platform: ${fingerprint.platform}`, 'info', this.instanceId);
        log('STEALTH', `Timezone: ${fingerprint.timezone}`, 'info', this.instanceId);
        
        return true;
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
            let deploymentCompleted = false;
            let deploymentStarted = false;
            
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
                
                if (output.includes('Deploying') || output.includes('deployment started')) {
                    deploymentStarted = true;
                    log('DOCKER', 'Deployment started, waiting for completion...', 'info', this.instanceId);
                }
                
                if (output.includes('All 3 apps deployed') || 
                    output.includes('successfully deployed') || 
                    output.includes('Deployment completed')) {
                    deploymentCompleted = true;
                    log('DOCKER', '✅ Deployment completed successfully!', 'success', this.instanceId);
                    resolve({ success: true, email, deployedApps });
                }
                
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
                    fingerprint: this.currentFingerprint
                });
            }
            
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
        log('START', '=== BOT STARTING WITH HIGH ANONYMITY ===', 'info', this.instanceId);
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
                    this.mailPage = null;
                    this.oauthHandled = false;
                    this.currentFingerprint = null;
                    
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
                <thead><tr><th>Bot</th><th>Email</th><th>Password</th><th>Apps</th><th>Created</th></tr></thead>
                <tbody id="accountsBody"><tr><td colspan="5">Loading......</td>}</tr></tbody>
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
    console.log(`\n🚀 Starting application with HIGH ANONYMITY mode...`);
    
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
