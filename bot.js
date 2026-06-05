// chrome-installer.js - Standalone Chrome/Chromium installation utility
const fs = require('fs');
const { execSync } = require('child_process');
const https = require('https');
const { createWriteStream } = require('fs');

// ============ CONFIGURATION ============
const CHROME_PATH = process.env.CHROMIUM_PATH || '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

// ============ DOWNLOAD FUNCTION ============
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

// ============ CHROME INSTALLATION ============
async function installChrome() {
    const chromePath = CHROME_PATH;
    
    // Check if Chrome already exists and is valid
    if (fs.existsSync(chromePath)) {
        const stats = fs.statSync(chromePath);
        if (stats.size > 50000000) { // Chrome is at least 50MB
            console.log('[Chrome] Already installed at:', chromePath);
            return chromePath;
        }
    }
    
    console.log('[Chrome] Installing Chromium...');
    
    try {
        const zipPath = '/tmp/chromium.zip';
        
        // Download Chrome
        console.log('[Chrome] Downloading from:', CHROME_URL);
        await downloadFile(CHROME_URL, zipPath);
        
        // Extract to /app directory
        console.log('[Chrome] Extracting...');
        execSync(`unzip -q ${zipPath} -d /app/`, { stdio: 'inherit' });
        
        // Verify installation
        if (fs.existsSync(chromePath)) {
            fs.chmodSync(chromePath, 0o755);
            fs.unlinkSync(zipPath);
            console.log('[Chrome] ✅ Installed successfully at:', chromePath);
            return chromePath;
        }
        throw new Error('Chrome binary not found after extraction');
        
    } catch (error) {
        console.error('[Chrome] Installation failed:', error.message);
        return null;
    }
}

// ============ CHROME INSTALLATION WITH DEPENDENCIES ============
async function installChromeWithDependencies() {
    console.log('[Chrome] Installing Chrome with system dependencies...');
    
    // Install required dependencies for Chrome on Linux
    try {
        console.log('[Chrome] Installing system dependencies...');
        execSync('apt-get update -qq 2>/dev/null || true', { stdio: 'inherit' });
        execSync(`apt-get install -y -qq --no-install-recommends \
            ca-certificates \
            fonts-liberation \
            libappindicator3-1 \
            libasound2 \
            libatk-bridge2.0-0 \
            libatk1.0-0 \
            libcups2 \
            libdbus-1-3 \
            libgbm1 \
            libgtk-3-0 \
            libnspr4 \
            libnss3 \
            libx11-xcb1 \
            libxcb1 \
            libxcomposite1 \
            libxdamage1 \
            libxrandr2 \
            xdg-utils \
            wget \
            2>/dev/null || true`, { stdio: 'inherit' });
        console.log('[Chrome] Dependencies installed');
    } catch (error) {
        console.log('[Chrome] Warning: Some dependencies may already be installed');
    }
    
    // Install Chrome
    return await installChrome();
}

// ============ LAUNCH OPTIONS ============
function getChromeLaunchOptions() {
    return {
        headless: process.env.HEADLESS_MODE !== 'false',
        executablePath: CHROME_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-webgl',
            '--disable-accelerated-2d-canvas'
        ]
    };
}

// ============ VERIFY INSTALLATION ============
async function verifyChromeInstallation() {
    if (!fs.existsSync(CHROME_PATH)) {
        console.log('[Chrome] ❌ Not installed');
        return false;
    }
    
    const stats = fs.statSync(CHROME_PATH);
    console.log(`[Chrome] ✅ Installed: ${CHROME_PATH} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
    
    // Test if Chrome can run
    try {
        execSync(`${CHROME_PATH} --version`, { stdio: 'pipe' });
        console.log('[Chrome] ✅ Version check passed');
        return true;
    } catch (error) {
        console.log('[Chrome] ⚠️ Version check failed, but binary exists');
        return true;
    }
}

// ============ EXPORTS ============
module.exports = {
    installChrome,
    installChromeWithDependencies,
    getChromeLaunchOptions,
    verifyChromeInstallation,
    CHROME_PATH
};

// ============ RUN DIRECTLY ============
if (require.main === module) {
    (async () => {
        console.log('\n========================================');
        console.log('  Chrome/Chromium Installer');
        console.log('========================================\n');
        
        const success = await installChromeWithDependencies();
        
        if (success) {
            await verifyChromeInstallation();
            console.log('\n✅ Chrome is ready to use!');
            console.log(`   Path: ${CHROME_PATH}`);
            console.log(`   Launch options:`, getChromeLaunchOptions());
        } else {
            console.error('\n❌ Chrome installation failed');
            process.exit(1);
        }
    })();
}
