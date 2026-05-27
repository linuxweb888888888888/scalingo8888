require('dotenv').config();
const express = require('express');
const fs = require('fs');
const os = require('os');
const { execSync, spawn } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const { createWriteStream } = require('fs');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

// Apply stealth plugin
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;

// ============ CONFIGURATION: CREATOR ============
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';
let dbClient = null;
let db = null;

const ENV_CREATOR = {
    BOT_PASSWORD: process.env.BOT_PASSWORD || 'Linuxdistro&84',
    BOT_START_DELAY: parseInt(process.env.BOT_START_DELAY) || 10,
    HEADLESS_MODE: process.env.HEADLESS_MODE !== 'false',
    CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/app/chrome-linux64/chrome',
    CLEVER_TOKEN: process.env.CLEVER_TOKEN || '',
    SCALINGO_API_TOKEN: process.env.SCALINGO_API_TOKEN || '',
    SCALINGO_APP_NAME: process.env.SCALINGO_APP_NAME || ''
};

// ============ CONFIGURATION: HTX BOT ============
const config_htx = {
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    leverage: parseInt(process.env.LEVERAGE) || 10,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws'
};

// ============ STATE: CREATOR ============
let botStatusCreator = {
    state: 'starting',
    accountCreated: false,
    accountEmail: null,
    startTime: new Date(),
    completionTime: null,
    restartCount: 0
};

// ============ STATE: HTX BOT ============
let botStateHtx = {
    isRunning: true,
    isTrading: false,
    startTime: Date.now(),
    currentPrice: 0,
    avgPrice: 0,
    roi: 0,
    realizedProfit: 0,
    profitPct: 0,
    walletBalance: 0,
    displayBalance: 0,
    peakBalance: 0,
    initialBalance: 0,
    safetyOrdersFilled: 0,
    maxAffordableSteps: 0,
    distToNext: 0,
    profitShibLeveraged: 0, 
    settings: {
        baseOrder: 1,        
        priceDrop: 0.1,
        volumeMult: 1.2,
        takeProfit: 1.5,
        maxSteps: 999        
    },
    estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 },
    openPosition: { volume: 0, direction: "", costHold: 0 },
    allTimeHigh: 0,
    totalTrades: 0,
    winningTrades: 0
};

// ============ HELPERS: CREATOR ============
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function connectMongoDB() {
    try {
        dbClient = new MongoClient(MONGODB_URI);
        await dbClient.connect();
        db = dbClient.db('botdb');
        console.log('[MongoDB] Connected successfully');
        await db.createCollection('accounts', { capped: false });
        await db.collection('accounts').createIndex({ createdAt: -1 });
        return true;
    } catch (error) {
        console.error('[MongoDB] Connection failed:', error.message);
        return false;
    }
}

function logCreator(step, message, type = 'info', instanceId = 'MAIN') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${instanceId}] [${step}] ${message}`);
}

async function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = createWriteStream(destPath);
        https.get(url, (response) => {
            if (response.statusCode !== 200) { reject(new Error(`Failed to download: ${response.statusCode}`)); return; }
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
    });
}

async function installChromiumRuntime() {
    const chromePath = ENV_CREATOR.CHROMIUM_PATH;
    if (fs.existsSync(chromePath)) {
        const stats = fs.statSync(chromePath);
        if (stats.size > 50000000) return chromePath;
    }
    logCreator('SYSTEM', 'Installing Chromium...', 'info', 'MAIN');
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
        logCreator('SYSTEM', `Failed: ${error.message}`, 'error', 'MAIN');
        return null;
    }
}

function installScalingoCLI() {
    const cliPath = '/app/bin/scalingo';
    if (fs.existsSync(cliPath)) return true;
    try {
        if (!fs.existsSync('/app/bin')) fs.mkdirSync('/app/bin', { recursive: true });
        execSync('curl -L -o /tmp/scalingo.tar.gz https://github.com/Scalingo/cli/releases/download/1.44.1/scalingo_1.44.1_linux_amd64.tar.gz', { stdio: 'inherit' });
        execSync('cd /tmp && tar -xzf scalingo.tar.gz', { stdio: 'inherit' });
        execSync('cp /tmp/scalingo_1.44.1_linux_amd64/scalingo /app/bin/scalingo', { stdio: 'inherit' });
        execSync('chmod +x /app/bin/scalingo', { stdio: 'inherit' });
        return true;
    } catch (error) { return false; }
}

async function restartWithCLI() {
    const cliPath = '/app/bin/scalingo';
    const appName = ENV_CREATOR.SCALINGO_APP_NAME;
    const apiToken = ENV_CREATOR.SCALINGO_API_TOKEN;
    if (!fs.existsSync(cliPath) || !appName || !apiToken) return false;
    return new Promise((resolve) => {
        const cmd = `${cliPath} login --api-token "${apiToken}" && ${cliPath} --app ${appName} restart`;
        const child = spawn('bash', ['-c', cmd]);
        child.on('close', (code) => resolve(code === 0));
    });
}

// ============ HELPERS: HTX BOT ============
async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: config_htx.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config_htx.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config_htx.secretKey).update(payload).digest('base64');
    const url = `https://${config_htx.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        return res.data;
    } catch (e) { return null; }
}

function calculateMaxPossibleSteps(balance, leverage, baseOrder, multiplier, price) {
    if (price <= 0 || baseOrder <= 0 || balance <= 0) return 0;
    let totalContractsAccumulated = 0; let nextOrderSize = baseOrder; let buyingPower = balance * leverage; let steps = 0;
    while (true) {
        let totalValueWithNextStep = (totalContractsAccumulated + nextOrderSize) * price * 1000;
        if (totalValueWithNextStep > buyingPower) break;
        totalContractsAccumulated += nextOrderSize;
        nextOrderSize = Math.ceil(nextOrderSize * multiplier);
        steps++;
        if (steps > 500) break; 
    }
    return steps;
}

function calculateCurrentStep(totalVol, baseVol, multiplier) {
    if (totalVol <= baseVol) return 0;
    let step = 0; let runningTotal = baseVol; let lastOrder = baseVol;
    while (runningTotal < totalVol && step < 100) {
        step++;
        lastOrder = Math.ceil(lastOrder * multiplier);
        runningTotal += lastOrder;
        if (Math.abs(runningTotal - totalVol) / totalVol < 0.05 || runningTotal > totalVol) return step;
    }
    return step;
}

// ============ LOGIC: HTX BOT ============
async function syncHtxData() {
    try {
        const accRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            const equity = parseFloat(acc.margin_balance);
            const unrealized = parseFloat(acc.profit_unreal) || 0;
            const realBalance = equity - unrealized;
            if (botStateHtx.initialBalance <= 0) {
                botStateHtx.initialBalance = realBalance; botStateHtx.displayBalance = realBalance; botStateHtx.peakBalance = realBalance;
            }
            if (realBalance > botStateHtx.peakBalance) {
                botStateHtx.displayBalance += (realBalance - botStateHtx.peakBalance);
                botStateHtx.peakBalance = realBalance;
                if (botStateHtx.displayBalance > (botStateHtx.allTimeHigh || 0)) botStateHtx.allTimeHigh = botStateHtx.displayBalance;
            }
            botStateHtx.walletBalance = realBalance;
            botStateHtx.realizedProfit = botStateHtx.displayBalance - botStateHtx.initialBalance;
            botStateHtx.profitPct = (botStateHtx.realizedProfit / botStateHtx.initialBalance) * 100;
            if (botStateHtx.currentPrice > 0) {
                botStateHtx.profitShibLeveraged = (botStateHtx.realizedProfit * 10) / botStateHtx.currentPrice;
                botStateHtx.settings.baseOrder = Math.max(1, 1 + Math.floor(botStateHtx.profitShibLeveraged / 1000));
                botStateHtx.maxAffordableSteps = calculateMaxPossibleSteps(botStateHtx.walletBalance, config_htx.leverage, botStateHtx.settings.baseOrder, botStateHtx.settings.volumeMult, botStateHtx.currentPrice);
            }
        }
        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config_htx.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');
        if (pos) {
            botStateHtx.avgPrice = parseFloat(pos.cost_hold);
            botStateHtx.roi = parseFloat(pos.profit_rate) * 100;
            botStateHtx.openPosition = { volume: parseFloat(pos.volume), direction: pos.direction, costHold: botStateHtx.avgPrice };
            botStateHtx.safetyOrdersFilled = calculateCurrentStep(botStateHtx.openPosition.volume, botStateHtx.settings.baseOrder, botStateHtx.settings.volumeMult);
            const currentDrop = ((botStateHtx.avgPrice - botStateHtx.currentPrice) / botStateHtx.avgPrice) * 100;
            botStateHtx.distToNext = Math.max(0, botStateHtx.settings.priceDrop - currentDrop);
        } else {
            botStateHtx.openPosition = { volume: 0, direction: "", costHold: 0 };
            botStateHtx.roi = 0; botStateHtx.avgPrice = 0; botStateHtx.distToNext = 0; botStateHtx.safetyOrdersFilled = 0;
        }
        const elapsed = (Date.now() - botStateHtx.startTime) / 3600000;
        const hr = botStateHtx.realizedProfit / Math.max(elapsed, 0.01);
        botStateHtx.estimates = { hr, day: hr * 24, week: hr * 168, month: hr * 720, dgr: (hr * 24 / botStateHtx.initialBalance) * 100 };
    } catch (e) {}
}

async function checkHtxTrades() {
    if (!botStateHtx.isRunning || botStateHtx.isTrading || botStateHtx.currentPrice <= 0) return;
    botStateHtx.isTrading = true;
    try {
        const hasPos = botStateHtx.openPosition.volume > 0;
        if (hasPos && botStateHtx.roi >= botStateHtx.settings.takeProfit) {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config_htx.symbol, volume: botStateHtx.openPosition.volume, direction: 'sell', offset: 'close', lever_rate: config_htx.leverage, order_price_type: 'opponent' });
            botStateHtx.winningTrades++; botStateHtx.totalTrades++;
        } else if (hasPos) {
            const currentDrop = ((botStateHtx.avgPrice - botStateHtx.currentPrice) / botStateHtx.avgPrice) * 100;
            if (currentDrop >= botStateHtx.settings.priceDrop) {
                const nextVol = Math.max(1, Math.ceil(botStateHtx.settings.baseOrder * Math.pow(botStateHtx.settings.volumeMult, botStateHtx.safetyOrdersFilled + 1)));
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config_htx.symbol, volume: nextVol, direction: 'buy', offset: 'open', lever_rate: config_htx.leverage, order_price_type: 'opponent' });
                botStateHtx.totalTrades++;
            }
        } else if (!hasPos && botStateHtx.settings.baseOrder > 0) {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config_htx.symbol, volume: botStateHtx.settings.baseOrder, direction: 'buy', offset: 'open', lever_rate: config_htx.leverage, order_price_type: 'opponent' });
            botStateHtx.totalTrades++;
        }
    } catch (e) {}
    botStateHtx.isTrading = false;
}

// ============ LOGIC: CREATOR ============
class CleverCloudBot {
    constructor(instanceId, password, startDelay = 0) {
        this.instanceId = instanceId; this.browser = null; this.page = null; this.mailPage = null;
        this.realTempEmail = null; this.password = password; this.startDelay = startDelay; this.chromePath = null; this.oauthHandled = false;
    }
    async initBrowser() {
        if (!this.chromePath) this.chromePath = await installChromiumRuntime();
        if (!this.chromePath) throw new Error('No Chromium found');
        this.browser = await puppeteer.launch({ headless: ENV_CREATOR.HEADLESS_MODE, executablePath: this.chromePath, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1280, height: 800 });
    }
    async fetchTempEmail() {
        this.mailPage = await this.browser.newPage();
        await this.mailPage.goto('https://10minutemail.net/', { waitUntil: 'domcontentloaded' });
        await sleep(5000);
        this.realTempEmail = await this.mailPage.evaluate(() => {
            const input = document.querySelector('#fe_text');
            return input ? input.value : document.querySelector('#mailAddress')?.textContent;
        });
        if (!this.realTempEmail) throw new Error('Could not extract email');
        return this.realTempEmail;
    }
    async handleSignup(email, password) {
        await this.page.goto('https://api.clever-cloud.com/v2/sessions/signup', { waitUntil: 'networkidle2' });
        await sleep(3000);
        await this.page.type('input[type="email"]', email);
        await this.page.type('input[type="password"]', password);
        await this.page.evaluate(() => { document.querySelector('input[type="checkbox"]')?.click(); document.querySelector('#altcha_checkbox')?.click(); });
        let solved = false;
        for (let i = 0; i < 60; i++) {
            solved = await this.page.evaluate(() => { const input = document.querySelector('input[name="altcha"]'); return input && input.value.length > 20; });
            if (solved) break; await sleep(1000);
        }
        await this.page.evaluate(() => { Array.from(document.querySelectorAll('button')).find(x => x.innerText.toLowerCase().includes('sign up'))?.click(); });
        await sleep(8000);
    }
    async getVerificationLink() {
        const startTime = Date.now();
        while (Date.now() - startTime < 180000) {
            let link = await this.mailPage.evaluate(() => {
                const match = document.documentElement.innerHTML.match(/https:\/\/api\.clever-cloud\.com\/v2\/self\/validate_email\?validationKey=[a-f0-9-]+/);
                return match ? match[0] : null;
            });
            if (link) return link;
            await this.mailPage.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('#maillist tr'));
                for (const row of rows) {
                    if (row.innerText.toLowerCase().includes('clever')) { row.querySelector('a')?.click(); return true; }
                }
                return false;
            });
            await sleep(5000);
        }
        throw new Error('Verification timeout');
    }
    async handleOAuth(url, email, password) {
        try {
            const oauthPage = await this.browser.newPage();
            await oauthPage.goto(url, { waitUntil: 'networkidle2' });
            await sleep(3000);
            await oauthPage.evaluate((e, p) => {
                const ef = document.querySelector('input[type="email"]');
                const pf = document.querySelector('input[type="password"]');
                if (ef && pf) { ef.value = e; pf.value = p; ef.dispatchEvent(new Event('input', { bubbles: true })); pf.dispatchEvent(new Event('input', { bubbles: true })); return true; }
            }, email, password);
            await oauthPage.evaluate(() => { document.querySelector('button[type="submit"], input[type="submit"]')?.click() || document.querySelector('form')?.submit(); });
            await sleep(8000); await oauthPage.close(); return true;
        } catch (e) { return false; }
    }
    async startDockerInBackground(email, password) {
        return new Promise((resolve, reject) => {
            const dockerProcess = spawn('bash', ['/app/docker'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLEVER_TOKEN: ENV_CREATOR.CLEVER_TOKEN } });
            let deployedApps = [];
            dockerProcess.stdout.on('data', async (data) => {
                const output = data.toString();
                const oauthUrl = output.match(/https:\/\/console\.clever-cloud\.com\/cli-oauth\?[^\s]+/)?.[0];
                if (oauthUrl && !this.oauthHandled) { this.oauthHandled = true; await this.handleOAuth(oauthUrl, email, password); }
                const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.osc-fr1\.scalingo\.io/);
                if (urlMatch) deployedApps.push(urlMatch[0]);
                if (output.includes('All 3 apps deployed')) resolve({ success: true, email, deployedApps });
            });
            dockerProcess.on('close', (code) => deployedApps.length > 0 ? resolve({ success: true, email, deployedApps }) : reject(new Error('Exit: ' + code)));
            setTimeout(() => deployedApps.length > 0 ? resolve({ success: true, email, deployedApps }) : reject(new Error('Timeout')), 600000);
        });
    }
    async run() {
        if (this.startDelay > 0) await sleep(this.startDelay * 1000);
        botStatusCreator.state = 'running';
        try {
            await this.initBrowser();
            const email = await this.fetchTempEmail();
            botStatusCreator.accountEmail = email;
            await this.handleSignup(email, this.password);
            const verifyLink = await this.getVerificationLink();
            await this.page.goto(verifyLink, { waitUntil: 'domcontentloaded' });
            const result = await this.startDockerInBackground(email, this.password);
            if (db) await db.collection('accounts').insertOne({ email, password: this.password, deployedApps: result.deployedApps || [], createdAt: new Date() });
            botStatusCreator.accountCreated = true;
        } catch (e) { console.error(e.message); }
        if (this.browser) await this.browser.close();
        botStatusCreator.state = 'completed'; botStatusCreator.restartCount++;
        const cliSuccess = await restartWithCLI();
        if (!cliSuccess) process.exit(0);
    }
}

// ============ API ENDPOINTS ============
app.get('/api/creator/metrics', async (req, res) => {
    let total = 0, todayCount = 0;
    if (db) {
        total = await db.collection('accounts').countDocuments();
        const today = new Date(); today.setHours(0,0,0,0);
        todayCount = await db.collection('accounts').countDocuments({ createdAt: { $gte: today } });
    }
    res.json({ totalAccounts: total, completedToday: todayCount, botState: botStatusCreator.state, restartCount: botStatusCreator.restartCount, accountEmail: botStatusCreator.accountEmail });
});

app.get('/api/creator/accounts', async (req, res) => {
    if (!db) return res.json([]);
    const accounts = await db.collection('accounts').find({}).sort({ createdAt: -1 }).limit(50).toArray();
    res.json(accounts);
});

app.get('/api/bot/status', (req, res) => res.json(botStateHtx));

// ============ DASHBOARD: CREATOR ============
app.get('/creator', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Creator Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" />
    <style>
        body { background: #f5f7fb; font-family: 'Inter', sans-serif; padding: 40px; color: #1e293b; }
        .card { background: white; border-radius: 24px; padding: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; }
        h1 { font-size: 24px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 12px; border-bottom: 2px solid #edf2f7; }
        td { padding: 12px; border-bottom: 1px solid #edf2f7; }
        .badge { background: #eef2ff; color: #4338ca; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    </style>
</head>
<body>
    <h1>Clever Creator <span class="badge" id="botState">...</span></h1>
    <div class="grid">
        <div class="card"><h3>Total</h3><h2 id="total">0</h2></div>
        <div class="card"><h3>Today</h3><h2 id="today">0</h2></div>
        <div class="card"><h3>Restarts</h3><h2 id="restarts">0</h2></div>
        <div class="card"><h3>Current Email</h3><p id="email">-</p></div>
    </div>
    <div class="card">
        <table>
            <thead><tr><th>Email</th><th>Created</th></tr></thead>
            <tbody id="rows"></tbody>
        </table>
    </div>
    <script>
        async function update() {
            const m = await (await fetch('/api/creator/metrics')).json();
            document.getElementById('total').innerText = m.totalAccounts;
            document.getElementById('today').innerText = m.completedToday;
            document.getElementById('restarts').innerText = m.restartCount;
            document.getElementById('botState').innerText = m.botState;
            document.getElementById('email').innerText = m.accountEmail || '-';
            const accs = await (await fetch('/api/creator/accounts')).json();
            document.getElementById('rows').innerHTML = accs.map(a => \`<tr><td>\${a.email}</td><td>\${new Date(a.createdAt).toLocaleString()}</td></tr>\`).join('');
        }
        setInterval(update, 5000); update();
    </script>
</body></html>`);
});

// ============ DASHBOARD: HTX BOT ============
app.get('/bot', (req, res) => {
    res.send(`<!DOCTYPE html>
<html class="bg-white"><head><title>HTX Compounder PRO</title><script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
<style>body { font-family: 'Inter', sans-serif; }</style></head>
<body class="bg-gray-50 p-10"><div class="max-w-6xl mx-auto">
    <div class="flex justify-between items-center mb-8">
        <h1 class="text-3xl font-bold">HTX COMPOUND<span class="text-emerald-600">_BOT</span></h1>
        <div class="text-right"><p id="dgrText" class="text-3xl font-bold text-emerald-600">0.00%</p><p class="text-xs text-gray-400">Daily Growth</p></div>
    </div>
    <div class="grid grid-cols-5 gap-4 mb-8">
        <div class="bg-white p-6 rounded-2xl shadow-sm border border-gray-100"><p class="text-xs text-gray-400 mb-2">Net Profit</p><p id="p1" class="text-2xl font-bold text-emerald-600">$0.00</p></div>
        <div class="bg-white p-6 rounded-2xl shadow-sm border border-gray-100"><p class="text-xs text-gray-400 mb-2">ROI</p><p id="roi" class="text-2xl font-bold">0.00%</p></div>
        <div class="bg-white p-6 rounded-2xl shadow-sm border border-gray-100"><p class="text-xs text-gray-400 mb-2">Step</p><p id="stepText" class="text-2xl font-bold">0</p></div>
        <div class="bg-white p-6 rounded-2xl shadow-sm border border-gray-100"><p class="text-xs text-gray-400 mb-2">Trades</p><p id="totalTrades" class="text-2xl font-bold">0</p></div>
        <div class="bg-white p-6 rounded-2xl shadow-sm border border-gray-100"><p class="text-xs text-gray-400 mb-2">Price</p><p id="curPrice" class="text-xl font-bold">0.00</p></div>
    </div>
</div>
<script>
    async function update() {
        const d = await (await fetch('/api/bot/status')).json();
        document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
        document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
        document.getElementById('roi').style.color = d.roi >= 0 ? '#059669' : '#dc2626';
        document.getElementById('totalTrades').innerText = d.totalTrades;
        document.getElementById('stepText').innerText = d.safetyOrdersFilled;
        document.getElementById('dgrText').innerText = d.estimates.dgr.toFixed(4) + '%';
        document.getElementById('curPrice').innerText = d.currentPrice.toFixed(8);
    }
    setInterval(update, 1000); update();
</script></body></html>`);
});

// ============ INITIALIZATION ============
function startHTXWS() {
    const ws = new WebSocket(config_htx.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config_htx.symbol}.detail`, id: 'p1' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick?.close) botStateHtx.currentPrice = parseFloat(msg.tick.close);
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startHTXWS, 5000));
}

async function main() {
    installScalingoCLI();
    await connectMongoDB();
    
    app.listen(port, '0.0.0.0', () => console.log(`Dashboard running on port ${port}`));
    
    // Start HTX Bot Logic
    startHTXWS();
    setInterval(syncHtxData, 2000);
    setInterval(checkHtxTrades, 3000);
    
    // Start Creator Bot Instance
    const bot = new CleverCloudBot('INSTANCE_1', ENV_CREATOR.BOT_PASSWORD, ENV_CREATOR.BOT_START_DELAY);
    await bot.run();
}

main().catch(console.error);
