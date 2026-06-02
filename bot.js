// Updated index.js with paper trading support
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const ccxt = require('ccxt');
const PaperTradingEngine = require('./paperTradingEngine');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Check if paper trading is enabled
const PAPER_TRADING = process.env.PAPER_TRADING === 'true';
const INITIAL_BALANCE = parseFloat(process.env.INITIAL_PAPER_BALANCE) || 1000;

// Initialize exchange or paper trading
let exchange = null;
let paperEngine = null;

if (PAPER_TRADING) {
  console.log('📝 PAPER TRADING MODE ENABLED');
  console.log(`💰 Initial Paper Balance: ${INITIAL_BALANCE} USDT`);
  paperEngine = new PaperTradingEngine(INITIAL_BALANCE);
} else {
  exchange = new ccxt.htx({
    apiKey: process.env.HTX_API_KEY,
    secret: process.env.HTX_API_SECRET,
    password: process.env.HTX_API_PASSPHRASE,
    enableRateLimit: true,
  });
  console.log('🟢 LIVE TRADING MODE ENABLED');
}

// Trading state
let activePositions = [];
let closedTrades = [];
let dcaLevels = [];
let growthRateSettings = {
  morning: { enabled: true, rate: 0.5, hours: '06:00-12:00', label: '🌅 Morning (6AM-12PM)' },
  afternoon: { enabled: true, rate: 0.3, hours: '12:00-18:00', label: '☀️ Afternoon (12PM-6PM)' },
  evening: { enabled: true, rate: 0.2, hours: '18:00-00:00', label: '🌙 Evening (6PM-12AM)' },
  night: { enabled: false, rate: 0.1, hours: '00:00-06:00', label: '🌃 Night (12AM-6AM)' }
};

let totalPnL = 0;
let totalInvestment = 0;
let running = true;
let priceHistory = [];
let tradeStats = {
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
  bestTrade: 0,
  worstTrade: 0,
  averageWin: 0,
  averageLoss: 0
};

// Helper: Get current time-based growth rate
function getCurrentGrowthRate() {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentTime = currentHour * 60 + currentMinute;

  for (const [period, settings] of Object.entries(growthRateSettings)) {
    if (!settings.enabled) continue;
    
    const [start, end] = settings.hours.split('-');
    const [startHour, startMinute] = start.split(':').map(Number);
    const [endHour, endMinute] = end.split(':').map(Number);
    
    const startTime = startHour * 60 + startMinute;
    let endTime = endHour * 60 + endMinute;
    
    if (endTime < startTime) endTime += 24 * 60;
    let currentAdjusted = currentTime;
    if (currentTime < startTime && endTime > 24 * 60) currentAdjusted += 24 * 60;
    
    if (currentAdjusted >= startTime && currentAdjusted < endTime) {
      return settings.rate;
    }
  }
  return 0.2;
}

// Helper: Fetch current price (real or simulated)
async function getCurrentPrice() {
  if (PAPER_TRADING) {
    // For paper trading, simulate realistic price movements
    if (priceHistory.length === 0) {
      // Initial price for SHIB (realistic)
      return 0.00000850;
    }
    
    // Use last price with small random walk
    const lastPrice = priceHistory[priceHistory.length - 1].price;
    const change = (Math.random() - 0.5) * 0.0000002; // Small random movement
    let newPrice = lastPrice + change;
    
    // Keep price within reasonable range
    newPrice = Math.max(0.000005, Math.min(0.000015, newPrice));
    return newPrice;
  } else {
    try {
      const ticker = await exchange.fetchTicker(process.env.SYMBOL);
      return ticker.last;
    } catch (error) {
      console.error('Error fetching price:', error.message);
      return null;
    }
  }
}

// Helper: Calculate ROI for a position
function calculateROI(entryPrice, currentPrice, positionSize) {
  const investment = entryPrice * positionSize;
  const currentValue = currentPrice * positionSize;
  const pnl = currentValue - investment;
  const roi = (pnl / investment) * 100;
  return { roi, pnl, investment, currentValue };
}

// Execute buy order (supports both paper and real trading)
async function executeBuy(amountUSDT, reason = '') {
  try {
    const price = await getCurrentPrice();
    if (!price) return null;
    
    const quantity = amountUSDT / price;
    
    if (PAPER_TRADING) {
      const result = await paperEngine.marketBuy(process.env.SYMBOL, quantity, price, reason);
      if (!result.success) {
        console.error(`[PAPER BUY FAILED] ${result.error}`);
        return null;
      }
      
      const position = {
        id: result.position.id,
        entryPrice: price,
        quantity: quantity,
        amountUSDT: amountUSDT,
        timestamp: Date.now(),
        dcaLevel: dcaLevels.length,
        reason: reason,
        roi: 0,
        paper: true
      };
      
      activePositions.push(position);
      totalInvestment += amountUSDT;
      
      console.log(`[PAPER BUY] ${amountUSDT} USDT at ${price.toFixed(8)} - ${reason}`);
      return position;
    } else {
      const order = await exchange.createMarketBuyOrder(process.env.SYMBOL, quantity);
      
      const position = {
        id: order.id,
        entryPrice: price,
        quantity: quantity,
        amountUSDT: amountUSDT,
        timestamp: Date.now(),
        dcaLevel: dcaLevels.length,
        reason: reason,
        roi: 0,
        paper: false
      };
      
      activePositions.push(position);
      totalInvestment += amountUSDT;
      
      console.log(`[LIVE BUY] ${amountUSDT} USDT at ${price.toFixed(8)} - ${reason}`);
      return position;
    }
  } catch (error) {
    console.error('Buy error:', error.message);
    return null;
  }
}

// Execute sell order (supports both paper and real trading)
async function executeSell(position, reason = '') {
  try {
    const currentPrice = await getCurrentPrice();
    if (!currentPrice) return null;
    
    let pnl, roi, sellValue;
    
    if (PAPER_TRADING) {
      const paperPosition = paperEngine.positions.find(p => p.id === position.id);
      if (!paperPosition) {
        console.error('Paper position not found');
        return null;
      }
      
      const result = await paperEngine.marketSell(paperPosition, currentPrice, reason);
      pnl = result.pnl;
      roi = result.roi;
      sellValue = paperPosition.quantity * currentPrice;
    } else {
      const order = await exchange.createMarketSellOrder(process.env.SYMBOL, position.quantity);
      sellValue = currentPrice * position.quantity;
      pnl = sellValue - position.amountUSDT;
      roi = (pnl / position.amountUSDT) * 100;
    }
    
    position.exitPrice = currentPrice;
    position.exitTime = Date.now();
    position.pnl = pnl;
    position.roi = roi;
    position.reason = reason;
    
    closedTrades.push(position);
    totalPnL += pnl;
    
    // Update trade stats
    tradeStats.totalTrades++;
    if (pnl > 0) {
      tradeStats.winningTrades++;
      tradeStats.bestTrade = Math.max(tradeStats.bestTrade, pnl);
    } else if (pnl < 0) {
      tradeStats.losingTrades++;
      tradeStats.worstTrade = Math.min(tradeStats.worstTrade, pnl);
    }
    
    tradeStats.averageWin = tradeStats.winningTrades > 0 ? 
      closedTrades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0) / tradeStats.winningTrades : 0;
    tradeStats.averageLoss = tradeStats.losingTrades > 0 ?
      closedTrades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0) / tradeStats.losingTrades : 0;
    
    // Remove from active positions
    const index = activePositions.findIndex(p => p.id === position.id);
    if (index !== -1) activePositions.splice(index, 1);
    
    console.log(`[SELL] Position ${position.id} - PnL: ${pnl.toFixed(4)} USDT (${roi.toFixed(2)}%) - ${reason}`);
    return order;
  } catch (error) {
    console.error('Sell error:', error.message);
    return null;
  }
}

// DCA Trigger Check
async function checkDCA() {
  const currentPrice = await getCurrentPrice();
  if (!currentPrice || activePositions.length === 0) return;
  
  let totalQuantity = 0;
  let totalInvested = 0;
  
  for (const pos of activePositions) {
    totalQuantity += pos.quantity;
    totalInvested += pos.amountUSDT;
  }
  
  const averageEntry = totalInvested / totalQuantity;
  const { roi } = calculateROI(averageEntry, currentPrice, totalQuantity);
  
  if (roi < parseFloat(process.env.ROI_THRESHOLD) && dcaLevels.length < parseInt(process.env.MAX_DCA_LEVELS)) {
    const multiplier = parseFloat(process.env.DCA_MULTIPLIER);
    const previousAmount = dcaLevels.length === 0 ? 
      parseFloat(process.env.BASE_ORDER_AMOUNT) : 
      dcaLevels[dcaLevels.length - 1].amount * multiplier;
    
    const newAmount = previousAmount;
    dcaLevels.push({ level: dcaLevels.length + 1, amount: newAmount, price: currentPrice, time: Date.now() });
    
    console.log(`[DCA TRIGGER] ROI at ${roi.toFixed(2)}% (below ${process.env.ROI_THRESHOLD}%) - Adding ${newAmount.toFixed(2)} USDT`);
    await executeBuy(newAmount, `DCA Level ${dcaLevels.length} - ROI ${roi.toFixed(2)}%`);
  }
}

// Growth Rate Check
async function checkGrowthRate() {
  if (activePositions.length === 0) return;
  
  const currentPrice = await getCurrentPrice();
  if (!currentPrice) return;
  
  let totalQuantity = 0;
  let totalInvested = 0;
  
  for (const pos of activePositions) {
    totalQuantity += pos.quantity;
    totalInvested += pos.amountUSDT;
  }
  
  const averageEntry = totalInvested / totalQuantity;
  const growthRateTarget = getCurrentGrowthRate();
  const currentGrowth = ((currentPrice - averageEntry) / averageEntry) * 100;
  
  // Store price history for charts
  priceHistory.push({
    timestamp: Date.now(),
    price: currentPrice,
    growth: currentGrowth,
    target: growthRateTarget
  });
  
  // Keep last 1000 data points
  if (priceHistory.length > 1000) priceHistory.shift();
  
  console.log(`[${new Date().toLocaleTimeString()}] Growth: ${currentGrowth.toFixed(2)}% | Target: ${growthRateTarget}% | Active: ${activePositions.length}`);
  
  if (currentGrowth >= growthRateTarget) {
    console.log(`🎯 Growth target reached! Selling all positions...`);
    
    for (const position of [...activePositions]) {
      await executeSell(position, `Growth target ${growthRateTarget}% reached - ${currentGrowth.toFixed(2)}%`);
    }
    dcaLevels = [];
  } else if (currentGrowth < parseFloat(process.env.ROI_THRESHOLD)) {
    await checkDCA();
  }
}

// Schedule trading checks (every 30 seconds)
cron.schedule('*/30 * * * * *', async () => {
  if (!running) return;
  try {
    await checkGrowthRate();
  } catch (error) {
    console.error('Trading check error:', error);
  }
});

// Express Routes
app.get('/api/status', async (req, res) => {
  const currentPrice = await getCurrentPrice();
  const currentRate = getCurrentGrowthRate();
  
  let averageEntry = 0;
  let currentROI = 0;
  let currentPnL = 0;
  
  if (activePositions.length > 0) {
    let totalQuantity = 0;
    let totalInvestmentAmount = 0;
    for (const pos of activePositions) {
      totalQuantity += pos.quantity;
      totalInvestmentAmount += pos.amountUSDT;
    }
    averageEntry = totalInvestmentAmount / totalQuantity;
    const { roi, pnl } = calculateROI(averageEntry, currentPrice, totalQuantity);
    currentROI = roi;
    currentPnL = pnl;
  }
  
  let paperSummary = null;
  if (PAPER_TRADING && paperEngine) {
    const prices = { [process.env.SYMBOL]: currentPrice };
    paperSummary = paperEngine.getPortfolioSummary(prices);
  }
  
  res.json({
    mode: PAPER_TRADING ? 'paper' : 'live',
    running,
    currentPrice,
    currentGrowthRate: currentRate,
    activePositions: activePositions.length,
    activePositionsDetails: activePositions,
    dcaLevels,
    totalInvestment,
    totalPnL,
    netPnL: totalPnL,
    totalReturn: totalInvestment > 0 ? (totalPnL / totalInvestment) * 100 : 0,
    averageEntry,
    currentROI,
    currentPnL,
    growthRateSettings,
    closedTradesCount: closedTrades.length,
    paperSummary,
    tradeStats,
    priceHistory: priceHistory.slice(-100) // Last 100 price points
  });
});

app.get('/api/closed-trades', (req, res) => {
  res.json(closedTrades.sort((a, b) => b.exitTime - a.exitTime));
});

app.get('/api/paper/portfolio', (req, res) => {
  if (!PAPER_TRADING || !paperEngine) {
    return res.json({ error: 'Paper trading not enabled' });
  }
  res.json(paperEngine.getPortfolioSummary({ [process.env.SYMBOL]: 0 }));
});

app.get('/api/paper/orders', (req, res) => {
  if (!PAPER_TRADING || !paperEngine) {
    return res.json({ error: 'Paper trading not enabled' });
  }
  res.json(paperEngine.getAllOrders());
});

app.post('/api/paper/deposit', (req, res) => {
  if (!PAPER_TRADING || !paperEngine) {
    return res.json({ error: 'Paper trading not enabled' });
  }
  const { amount } = req.body;
  const result = paperEngine.deposit(amount);
  res.json(result);
});

app.post('/api/paper/withdraw', (req, res) => {
  if (!PAPER_TRADING || !paperEngine) {
    return res.json({ error: 'Paper trading not enabled' });
  }
  const { amount } = req.body;
  const result = paperEngine.withdraw(amount);
  res.json(result);
});

app.post('/api/paper/reset', (req, res) => {
  if (!PAPER_TRADING || !paperEngine) {
    return res.json({ error: 'Paper trading not enabled' });
  }
  const { balance } = req.body;
  paperEngine.reset(balance || INITIAL_BALANCE);
  // Also reset local state
  activePositions = [];
  closedTrades = [];
  dcaLevels = [];
  totalPnL = 0;
  totalInvestment = 0;
  tradeStats = {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    bestTrade: 0,
    worstTrade: 0,
    averageWin: 0,
    averageLoss: 0
  };
  res.json({ success: true, balance: paperEngine.balance });
});

app.get('/api/pnl-summary', (req, res) => {
  const winningTrades = closedTrades.filter(t => t.pnl > 0);
  const losingTrades = closedTrades.filter(t => t.pnl < 0);
  
  res.json({
    totalTrades: closedTrades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate: closedTrades.length > 0 ? (winningTrades.length / closedTrades.length * 100).toFixed(2) : 0,
    totalPnL: totalPnL,
    averageWin: winningTrades.length > 0 ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length : 0,
    averageLoss: losingTrades.length > 0 ? losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length : 0,
    bestTrade: winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.pnl)) : 0,
    worstTrade: losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.pnl)) : 0,
    totalROI: totalInvestment > 0 ? (totalPnL / totalInvestment * 100).toFixed(2) : 0,
    ...tradeStats
  });
});

app.post('/api/settings/growth-rate', (req, res) => {
  const { period, enabled, rate, hours } = req.body;
  if (growthRateSettings[period]) {
    growthRateSettings[period] = { ...growthRateSettings[period], enabled, rate, hours };
    res.json({ success: true, growthRateSettings });
  } else {
    res.status(400).json({ error: 'Invalid period' });
  }
});

app.post('/api/trade/start', (req, res) => {
  if (!running) {
    running = true;
    res.json({ success: true, message: 'Bot started' });
  } else {
    res.json({ success: false, message: 'Bot already running' });
  }
});

app.post('/api/trade/stop', (req, res) => {
  running = false;
  res.json({ success: true, message: 'Bot stopped' });
});

app.post('/api/trade/manual-buy', async (req, res) => {
  const { amount, reason } = req.body;
  const position = await executeBuy(amount || parseFloat(process.env.BASE_ORDER_AMOUNT), reason || 'Manual buy');
  res.json({ success: !!position, position });
});

app.post('/api/trade/manual-sell', async (req, res) => {
  if (activePositions.length === 0) {
    return res.json({ success: false, message: 'No active positions' });
  }
  
  for (const position of [...activePositions]) {
    await executeSell(position, 'Manual sell');
  }
  dcaLevels = [];
  res.json({ success: true });
});

app.post('/api/reset', (req, res) => {
  activePositions = [];
  closedTrades = [];
  dcaLevels = [];
  totalPnL = 0;
  totalInvestment = 0;
  tradeStats = {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    bestTrade: 0,
    worstTrade: 0,
    averageWin: 0,
    averageLoss: 0
  };
  priceHistory = [];
  res.json({ success: true, message: 'All data reset' });
});

// HTML Dashboard with enhanced paper trading UI
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>SHIB HTX Growth Bot - ${PAPER_TRADING ? 'Paper Trading' : 'Live Trading'}</title>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%); color: #fff; padding: 20px; }
        .container { max-width: 1600px; margin: 0 auto; }
        h1 { color: #00d4ff; margin-bottom: 20px; display: flex; align-items: center; gap: 15px; }
        .badge { padding: 5px 15px; border-radius: 20px; font-size: 14px; font-weight: bold; }
        .badge.paper { background: #ff9800; color: #000; }
        .badge.live { background: #4caf50; color: #fff; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: rgba(255,255,255,0.1); border-radius: 10px; padding: 20px; backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.2); transition: transform 0.3s; }
        .card:hover { transform: translateY(-5px); }
        .card h3 { margin-bottom: 15px; color: #00d4ff; border-left: 3px solid #00d4ff; padding-left: 10px; }
        .stat { display: flex; justify-content: space-between; margin-bottom: 10px; padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); }
        .stat-label { font-weight: bold; }
        .stat-value { font-family: monospace; font-size: 16px; }
        .positive { color: #00ff88; }
        .negative { color: #ff4466; }
        button { background: #00d4ff; color: #0a0e27; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; font-weight: bold; transition: all 0.3s; }
        button:hover { transform: scale(1.05); opacity: 0.9; }
        button.danger { background: #ff4466; color: white; }
        button.warning { background: #ffaa00; color: #000; }
        button.success { background: #00ff88; color: #000; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
        th { background: rgba(0,212,255,0.2); }
        .settings-group { margin-bottom: 15px; }
        .settings-group label { display: block; margin-bottom: 5px; }
        input, select { padding: 8px; border-radius: 5px; border: 1px solid #00d4ff; background: rgba(255,255,255,0.1); color: #fff; width: 100%; }
        .refresh { position: fixed; bottom: 20px; right: 20px; background: #00d4ff; width: 50px; height: 50px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.3); z-index: 1000; }
        .refresh:hover { transform: rotate(90deg); transition: 0.3s; }
        canvas { max-height: 300px; }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 2000; justify-content: center; align-items: center; }
        .modal-content { background: #1a1f3a; padding: 30px; border-radius: 10px; max-width: 500px; width: 90%; }
        .close { float: right; cursor: pointer; font-size: 28px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>
          🚀 SHIB HTX Growth Rate Bot 
          <span class="badge ${PAPER_TRADING ? 'paper' : 'live'}">${PAPER_TRADING ? '📝 PAPER TRADING' : '🔴 LIVE TRADING'}</span>
        </h1>
        
        <div class="grid">
          <div class="card">
            <h3>📊 Live Status</h3>
            <div id="status"></div>
          </div>
          
          <div class="card">
            <h3>💰 Portfolio Summary</h3>
            <div id="portfolio"></div>
          </div>
          
          <div class="card">
            <h3>📈 Price & Growth Chart</h3>
            <canvas id="priceChart"></canvas>
          </div>
          
          <div class="card">
            <h3>⚙️ Growth Rate Settings</h3>
            <div id="settings"></div>
          </div>
          
          <div class="card">
            <h3>🎮 Controls</h3>
            <button onclick="startBot()">▶️ Start Bot</button>
            <button onclick="stopBot()" class="danger">⏸️ Stop Bot</button>
            <button onclick="manualBuy()">💰 Manual Buy (10 USDT)</button>
            <button onclick="manualSell()" class="warning">💸 Manual Sell All</button>
            <button onclick="resetData()">🔄 Reset Data</button>
            ${PAPER_TRADING ? '<button onclick="showPaperModal()" class="success">📝 Paper Trading Controls</button>' : ''}
          </div>
        </div>
        
        <div class="card">
          <h3>📈 Active Positions (<span id="activeCount">0</span>)</h3>
          <div id="activePositions" style="max-height: 300px; overflow-y: auto;"></div>
        </div>
        
        <div class="card">
          <h3>✅ Closed Trades (<span id="closedCount">0</span>)</h3>
          <div id="closedTrades" style="max-height: 400px; overflow-y: auto;"></div>
        </div>
      </div>
      
      <div class="refresh" onclick="refreshData()">🔄</div>
      
      ${PAPER_TRADING ? `
      <div id="paperModal" class="modal">
        <div class="modal-content">
          <span class="close" onclick="closePaperModal()">&times;</span>
          <h2>📝 Paper Trading Controls</h2>
          <div class="stat">
            <span class="stat-label">Current Balance:</span>
            <span class="stat-value" id="paperBalance">0</span>
          </div>
          <div class="stat">
            <span class="stat-label">Initial Balance:</span>
            <span class="stat-value" id="paperInitialBalance">0</span>
          </div>
          <div class="stat">
            <span class="stat-label">Realized PnL:</span>
            <span class="stat-value" id="paperRealizedPnL">0</span>
          </div>
          <div class="stat">
            <span class="stat-label">Unrealized PnL:</span>
            <span class="stat-value" id="paperUnrealizedPnL">0</span>
          </div>
          <div class="stat">
            <span class="stat-label">Total PnL:</span>
            <span class="stat-value" id="paperTotalPnL">0</span>
          </div>
          <div class="stat">
            <span class="stat-label">Win Rate:</span>
            <span class="stat-value" id="paperWinRate">0</span>
          </div>
          <hr style="margin: 15px 0;">
          <h3>Adjust Balance</h3>
          <input type="number" id="depositAmount" placeholder="Amount in USDT" step="10">
          <button onclick="deposit()" class="success">Deposit</button>
          <button onclick="withdraw()" class="warning">Withdraw</button>
          <button onclick="resetPaper()" class="danger">Reset Paper Trading</button>
        </div>
      </div>
      ` : ''}
      
      <script>
        let priceChart = null;
        
        ${PAPER_TRADING ? `
        function showPaperModal() {
          document.getElementById('paperModal').style.display = 'flex';
          updatePaperInfo();
        }
        
        function closePaperModal() {
          document.getElementById('paperModal').style.display = 'none';
        }
        
        async function updatePaperInfo() {
          const res = await fetch('/api/paper/portfolio');
          const data = await res.json();
          document.getElementById('paperBalance').innerHTML = data.balance.toFixed(2) + ' USDT';
          document.getElementById('paperInitialBalance').innerHTML = data.initialBalance.toFixed(2) + ' USDT';
          document.getElementById('paperRealizedPnL').innerHTML = (data.realizedPnL > 0 ? '+' : '') + data.realizedPnL.toFixed(4) + ' USDT';
          document.getElementById('paperUnrealizedPnL').innerHTML = (data.unrealizedPnL > 0 ? '+' : '') + data.unrealizedPnL.toFixed(4) + ' USDT';
          document.getElementById('paperTotalPnL').innerHTML = (data.totalPnL > 0 ? '+' : '') + data.totalPnL.toFixed(4) + ' USDT';
          document.getElementById('paperWinRate').innerHTML = data.winRate.toFixed(2) + '%';
        }
        
        async function deposit() {
          const amount = parseFloat(document.getElementById('depositAmount').value);
          if (isNaN(amount) || amount <= 0) {
            alert('Please enter a valid amount');
            return;
          }
          await fetch('/api/paper/deposit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount })
          });
          await updatePaperInfo();
          await refreshData();
          document.getElementById('depositAmount').value = '';
        }
        
        async function withdraw() {
          const amount = parseFloat(document.getElementById('depositAmount').value);
          if (isNaN(amount) || amount <= 0) {
            alert('Please enter a valid amount');
            return;
          }
          await fetch('/api/paper/withdraw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount })
          });
          await updatePaperInfo();
          await refreshData();
          document.getElementById('depositAmount').value = '';
        }
        
        async function resetPaper() {
          if (confirm('Reset paper trading balance and all trades?')) {
            await fetch('/api/paper/reset', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ balance: 1000 })
            });
            await updatePaperInfo();
            await refreshData();
          }
        }
        ` : ''}
        
        function updatePriceChart(priceHistory) {
          const ctx = document.getElementById('priceChart').getContext('2d');
          if (priceChart) priceChart.destroy();
          
          priceChart = new Chart(ctx, {
            type: 'line',
            data: {
              labels: priceHistory.map(p => new Date(p.timestamp).toLocaleTimeString()),
              datasets: [
                {
                  label: 'Price (USDT)',
                  data: priceHistory.map(p => p.price * 1000000),
                  borderColor: '#00d4ff',
                  backgroundColor: 'rgba(0,212,255,0.1)',
                  tension: 0.4,
                  yAxisID: 'y'
                },
                {
                  label: 'Growth Rate (%)',
                  data: priceHistory.map(p => p.growth),
                  borderColor: '#00ff88',
                  backgroundColor: 'rgba(0,255,136,0.1)',
                  tension: 0.4,
                  yAxisID: 'y1'
                }
              ]
            },
            options: {
              responsive: true,
              maintainAspectRatio: true,
              interaction: { mode: 'index', intersect: false },
              plugins: {
                legend: { position: 'top', labels: { color: '#fff' } },
                tooltip: { mode: 'index', intersect: false }
              },
              scales: {
                y: { title: { display: true, text: 'Price (x1,000,000 USDT)', color: '#00d4ff' }, ticks: { color: '#00d4ff' } },
                y1: { position: 'right', title: { display: true, text: 'Growth Rate (%)', color: '#00ff88' }, ticks: { color: '#00ff88' }, grid: { drawOnChartArea: false } }
              }
            }
          });
        }
        
        async function refreshData() {
          const statusRes = await fetch('/api/status');
          const status = await statusRes.json();
          const pnlRes = await fetch('/api/pnl-summary');
          const pnl = await pnlRes.json();
          const closedRes = await fetch('/api/closed-trades');
          const closed = await closedRes.json();
          
          // Update status
          document.getElementById('status').innerHTML = \`
            <div class="stat"><span class="stat-label">Bot Status:</span><span class="stat-value">\${status.running ? '🟢 Running' : '🔴 Stopped'}</span></div>
            <div class="stat"><span class="stat-label">Mode:</span><span class="stat-value">\${status.mode === 'paper' ? '📝 Paper Trading' : '🔴 Live Trading'}</span></div>
            <div class="stat"><span class="stat-label">Current Price:</span><span class="stat-value">\${status.currentPrice ? (status.currentPrice * 1000000).toFixed(2) + ' (x1,000,000)' : 'N/A'}</span></div>
            <div class="stat"><span class="stat-label">Current Growth Target:</span><span class="stat-value">\${status.currentGrowthRate}%</span></div>
            <div class="stat"><span class="stat-label">Active Positions:</span><span class="stat-value">\${status.activePositions}</span></div>
            <div class="stat"><span class="stat-label">Total Investment:</span><span class="stat-value">\${status.totalInvestment.toFixed(2)} USDT</span></div>
            <div class="stat"><span class="stat-label">Total PnL:</span><span class="stat-value \${status.totalPnL >= 0 ? 'positive' : 'negative'}">\${status.totalPnL.toFixed(4)} USDT</span></div>
            <div class="stat"><span class="stat-label">Total Return:</span><span class="stat-value \${status.totalReturn >= 0 ? 'positive' : 'negative'}">\${status.totalReturn.toFixed(2)}%</span></div>
            <div class="stat"><span class="stat-label">Current ROI:</span><span class="stat-value \${status.currentROI >= 0 ? 'positive' : 'negative'}">\${status.currentROI.toFixed(2)}%</span></div>
            <div class="stat"><span class="stat-label">Current PnL:</span><span class="stat-value \${status.currentPnL >= 0 ? 'positive' : 'negative'}">\${status.currentPnL.toFixed(4)} USDT</span></div>
          \`;
          
          // Update portfolio for paper trading
          if (status.paperSummary) {
            document.getElementById('portfolio').innerHTML = \`
              <div class="stat"><span class="stat-label">Paper Balance:</span><span class="stat-value">\${status.paperSummary.balance.toFixed(2)} USDT</span></div>
              <div class="stat"><span class="stat-label">Total Value:</span><span class="stat-value">\${status.paperSummary.totalValue.toFixed(2)} USDT</span></div>
              <div class="stat"><span class="stat-label">Realized PnL:</span><span class="stat-value \${status.paperSummary.realizedPnL >= 0 ? 'positive' : 'negative'}">\${status.paperSummary.realizedPnL.toFixed(4)} USDT</span></div>
              <div class="stat"><span class="stat-label">Unrealized PnL:</span><span class="stat-value \${status.paperSummary.unrealizedPnL >= 0 ? 'positive' : 'negative'}">\${status.paperSummary.unrealizedPnL.toFixed(4)} USDT</span></div>
              <div class="stat"><span class="stat-label">Total PnL:</span><span class="stat-value \${status.paperSummary.totalPnL >= 0 ? 'positive' : 'negative'}">\${status.paperSummary.totalPnL.toFixed(4)} USDT</span></div>
              <div class="stat"><span class="stat-label">Total ROI:</span><span class="stat-value \${status.paperSummary.totalROI >= 0 ? 'positive' : 'negative'}">\${status.paperSummary.totalROI.toFixed(2)}%</span></div>
              <div class="stat"><span class="stat-label">Win Rate:</span><span class="stat-value">\${status.paperSummary.winRate.toFixed(2)}%</span></div>
            \`;
          } else {
            document.getElementById('portfolio').innerHTML = \`
              <div class="stat"><span class="stat-label">Total Trades:</span><span class="stat-value">\${pnl.totalTrades}</span></div>
              <div class="stat"><span class="stat-label">Win Rate:</span><span class="stat-value">\${pnl.winRate}% (\${pnl.winningTrades}/\${pnl.totalTrades})</span></div>
              <div class="stat"><span class="stat-label">Total PnL:</span><span class="stat-value \${pnl.totalPnL >= 0 ? 'positive' : 'negative'}">\${pnl.totalPnL.toFixed(4)} USDT</span></div>
              <div class="stat"><span class="stat-label">Total ROI:</span><span class="stat-value \${pnl.totalROI >= 0 ? 'positive' : 'negative'}">\${pnl.totalROI}%</span></div>
              <div class="stat"><span class="stat-label">Avg Win:</span><span class="stat-value positive">+\${pnl.averageWin.toFixed(4)} USDT</span></div>
              <div class="stat"><span class="stat-label">Avg Loss:</span><span class="stat-value negative">\${pnl.averageLoss.toFixed(4)} USDT</span></div>
              <div class="stat"><span class="stat-label">Best Trade:</span><span class="stat-value positive">+\${pnl.bestTrade.toFixed(4)} USDT</span></div>
              <div class="stat"><span class="stat-label">Worst Trade:</span><span class="stat-value negative">\${pnl.worstTrade.toFixed(4)} USDT</span></div>
            \`;
          }
          
          // Update price chart
          if (status.priceHistory && status.priceHistory.length > 0) {
            updatePriceChart(status.priceHistory);
          }
          
          // Update settings
          const settingsHtml = Object.entries(status.growthRateSettings).map(([period, setting]) => \`
            <div class="settings-group">
              <label>\${setting.label || period}</label>
              <input type="range" min="0" max="2" step="0.1" value="\${setting.rate}" onchange="updateRate('\${period}', this.value)" \${!setting.enabled ? 'disabled' : ''}>
              <span>\${setting.rate}%</span>
              <label><input type="checkbox" \${setting.enabled ? 'checked' : ''} onchange="togglePeriod('\${period}', this.checked)"> Enabled</label>
            </div>
          \`).join('');
          document.getElementById('settings').innerHTML = settingsHtml;
          
          // Active positions
          document.getElementById('activeCount').innerText = status.activePositionsDetails.length;
          if (status.activePositionsDetails.length === 0) {
            document.getElementById('activePositions').innerHTML = '<p style="text-align: center; padding: 20px;">📭 No active positions</p>';
          } else {
            document.getElementById('activePositions').innerHTML = \`
              <table>
                <thead><tr><th>Time</th><th>Entry Price</th><th>Quantity</th><th>Amount (USDT)</th><th>DCA Level</th><th>Reason</th></tr></thead>
                <tbody>
                  \${status.activePositionsDetails.map(pos => \`
                    <tr>
                      <td>\${new Date(pos.timestamp).toLocaleTimeString()}</td>
                      <td>\${(pos.entryPrice * 1000000).toFixed(2)} (x1M)</td>
                      <td>\${pos.quantity.toFixed(2)}</td>
                      <td>\${pos.amountUSDT.toFixed(2)}</td>
                      <td>\${pos.dcaLevel}</td>
                      <td>\${pos.reason || '-'}</td>
                    </tr>
                  \`).join('')}
                </tbody>
              </table>
            \`;
          }
          
          // Closed trades
          document.getElementById('closedCount').innerText = closed.length;
          if (closed.length === 0) {
            document.getElementById('closedTrades').innerHTML = '<p style="text-align: center; padding: 20px;">📭 No closed trades yet</p>';
          } else {
            document.getElementById('closedTrades').innerHTML = \`
              <table>
                <thead><tr><th>Entry Time</th><th>Exit Time</th><th>Entry Price</th><th>Exit Price</th><th>PnL (USDT)</th><th>ROI (%)</th><th>Reason</th></tr></thead>
                <tbody>
                  \${closed.slice(0, 50).map(trade => \`
                    <tr>
                      <td>\${new Date(trade.timestamp).toLocaleString()}</td>
                      <td>\${new Date(trade.exitTime).toLocaleString()}</td>
                      <td>\${(trade.entryPrice * 1000000).toFixed(2)}</td>
                      <td>\${(trade.exitPrice * 1000000).toFixed(2)}</td>
                      <td class="\${trade.pnl >= 0 ? 'positive' : 'negative'}">\${trade.pnl >= 0 ? '+' : ''}\${trade.pnl.toFixed(4)}</td>
                      <td class="\${trade.roi >= 0 ? 'positive' : 'negative'}">\${trade.roi >= 0 ? '+' : ''}\${trade.roi.toFixed(2)}%</td>
                      <td>\${trade.reason || '-'}</td>
                    </tr>
                  \`).join('')}
                </tbody>
              </table>
            \`;
          }
        }
        
        async function updateRate(period, rate) {
          await fetch('/api/settings/growth-rate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ period, enabled: true, rate: parseFloat(rate), hours: '00:00-24:00' })
          });
          refreshData();
        }
        
        async function togglePeriod(period, enabled) {
          await fetch('/api/settings/growth-rate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ period, enabled, rate: 0.5, hours: '00:00-24:00' })
          });
          refreshData();
        }
        
        async function startBot() {
          await fetch('/api/trade/start', { method: 'POST' });
          refreshData();
        }
        
        async function stopBot() {
          await fetch('/api/trade/stop', { method: 'POST' });
          refreshData();
        }
        
        async function manualBuy() {
          await fetch('/api/trade/manual-buy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 10, reason: 'Manual buy' })
          });
          refreshData();
        }
        
        async function manualSell() {
          if (confirm('Sell all active positions?')) {
            await fetch('/api/trade/manual-sell', { method: 'POST' });
            refreshData();
          }
        }
        
        async function resetData() {
          if (confirm('⚠️ WARNING: This will reset all trade data. Are you sure?')) {
            await fetch('/api/reset', { method: 'POST' });
            refreshData();
          }
        }
        
        refreshData();
        setInterval(refreshData, 5000);
      </script>
    </body>
    </html>
  `);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 SHIB HTX Growth Bot running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🎮 Mode: ${PAPER_TRADING ? 'PAPER TRADING' : 'LIVE TRADING'}`);
  console.log(`💰 ${PAPER_TRADING ? `Paper Balance: ${INITIAL_BALANCE} USDT` : `Symbol: ${process.env.SYMBOL}`}`);
  console.log(`⚙️ Base Order: ${process.env.BASE_ORDER_AMOUNT} USDT`);
  console.log(`📈 DCA Multiplier: ${process.env.DCA_MULTIPLIER}x`);
  console.log(`🎯 ROI Threshold: ${process.env.ROI_THRESHOLD}%\n`);
});
