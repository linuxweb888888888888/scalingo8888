const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// All namespaces to check
const NAMESPACES = [
  'phemextradebot', 
  'linux84744474', 
  'linux88884474', 
  'webapps84', 
  'tradingbotapp', 
  'webcoder4', 
  'weblinux84', 
  'tradepackage', 
  'hitbtctradebot', 
  'webwebwebwebwebweb', 
  'webpackage', 
  'clevertradebot', 
  'linux88888888', 
  'linuxlinuxlinuxlinux8888', 
  'tradeincbot', 
  'tradeincbotbot', 
  'buyrunplace'
];

console.log(`========================================`);
console.log(`🚀 Docker Hub Metrics Dashboard`);
console.log(`========================================`);
console.log(`📋 Monitoring: ${NAMESPACES.join(', ')}`);
console.log(`========================================\n`);

// Cache with initial demo data
let cachedData = {
  images: [
    { name: "bitcointradebot", namespace: "phemextradebot", pullCount: 49109, fullName: "phemextradebot/bitcointradebot" },
    { name: "dashboard", namespace: "phemextradebot", pullCount: 2880, fullName: "phemextradebot/dashboard" },
    { name: "bot", namespace: "phemextradebot", pullCount: 4931, fullName: "phemextradebot/bot" },
    { name: "web", namespace: "phemextradebot", pullCount: 102027, fullName: "phemextradebot/web" },
    { name: "exchange", namespace: "phemextradebot", pullCount: 3699, fullName: "phemextradebot/exchange" }
  ],
  totalPulls: 162646,
  totalImages: 55,
  namespaceStats: {
    phemextradebot: { imageCount: 55, totalPulls: 162646 }
  },
  recentChanges: [
    { name: "web", namespace: "phemextradebot", diff: 102027, timestamp: new Date() },
    { name: "bitcointradebot", namespace: "phemextradebot", diff: 49109, timestamp: new Date() }
  ],
  lastUpdate: new Date(),
  isReady: true
};

let isUpdating = false;

// Fetch helper with timeout
function fetchJSON(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Get repositories for a namespace
async function getRepositories(namespace) {
  try {
    const url = `https://hub.docker.com/v2/repositories/${namespace}/?page_size=100`;
    const data = await fetchJSON(url, 8000);
    return data.results || [];
  } catch (error) {
    console.log(`  ⚠️ Could not fetch ${namespace}: ${error.message}`);
    return [];
  }
}

// Get pull count for an image
async function getPullCount(namespace, image) {
  try {
    const url = `https://hub.docker.com/v2/repositories/${namespace}/${image}`;
    const data = await fetchJSON(url, 5000);
    return data.pull_count || 0;
  } catch (error) {
    return 0;
  }
}

// Main fetch function
async function fetchRealData() {
  const allImages = [];
  const changes = [];
  
  console.log(`\n🔍 Scanning ${NAMESPACES.length} namespaces...`);
  
  for (const namespace of NAMESPACES) {
    console.log(`  Checking: ${namespace}`);
    const repos = await getRepositories(namespace);
    
    if (repos.length === 0) {
      console.log(`    ❌ No public repositories found`);
      continue;
    }
    
    console.log(`    ✅ Found ${repos.length} repositories`);
    
    for (const repo of repos.slice(0, 30)) { // Limit to 30 per namespace
      const imageName = repo.name;
      const pullCount = await getPullCount(namespace, imageName);
      
      if (pullCount > 0) {
        allImages.push({
          name: imageName,
          namespace: namespace,
          fullName: `${namespace}/${imageName}`,
          pullCount: pullCount,
          lastUpdated: repo.last_updated
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  
  // Sort by pull count
  allImages.sort((a, b) => b.pullCount - a.pullCount);
  
  // Calculate stats
  const namespaceStats = {};
  for (const img of allImages) {
    if (!namespaceStats[img.namespace]) {
      namespaceStats[img.namespace] = { imageCount: 0, totalPulls: 0 };
    }
    namespaceStats[img.namespace].imageCount++;
    namespaceStats[img.namespace].totalPulls += img.pullCount;
  }
  
  const totalPulls = allImages.reduce((sum, img) => sum + img.pullCount, 0);
  
  console.log(`\n📊 Real data: ${allImages.length} images, ${totalPulls.toLocaleString()} pulls`);
  console.log(`📦 Namespaces: ${Object.keys(namespaceStats).join(', ')}`);
  
  return {
    images: allImages,
    totalPulls: totalPulls,
    totalImages: allImages.length,
    namespaceStats: namespaceStats,
    recentChanges: cachedData.recentChanges || [],
    lastUpdate: new Date(),
    isReady: true
  };
}

// Background updater
async function updateData() {
  if (isUpdating) return;
  
  isUpdating = true;
  
  try {
    console.log(`\n[${new Date().toLocaleTimeString()}] Fetching data...`);
    const realData = await fetchRealData();
    
    if (realData.totalImages > 0) {
      cachedData = { ...cachedData, ...realData };
      console.log(`✅ Updated: ${cachedData.totalImages} images, ${cachedData.totalPulls.toLocaleString()} pulls`);
    } else {
      console.log(`⚠️ No data from API, keeping demo data`);
    }
  } catch (error) {
    console.error(`❌ Error:`, error.message);
  } finally {
    isUpdating = false;
  }
}

// Express middleware
app.use(express.json());

// API endpoint - ALWAYS returns data immediately
app.get('/api/metrics', (req, res) => {
  console.log(`📊 API called - returning ${cachedData.totalImages} images`);
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    data: {
      images: cachedData.images || [],
      totalPulls: cachedData.totalPulls || 0,
      totalImages: cachedData.totalImages || 0,
      namespaceStats: cachedData.namespaceStats || {},
      recentChanges: cachedData.recentChanges || [],
      lastUpdate: cachedData.lastUpdate || new Date(),
      isReady: true
    }
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    totalImages: cachedData.totalImages,
    totalPulls: cachedData.totalPulls,
    lastUpdate: cachedData.lastUpdate
  });
});

// Main HTML page
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Docker Hub Metrics Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Inter', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: #1a202c;
        }
        .container { max-width: 1400px; margin: 0 auto; padding: 24px; }
        .header {
            background: white;
            border-radius: 24px;
            padding: 32px;
            margin-bottom: 32px;
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
        }
        .header h1 {
            font-size: 2rem;
            font-weight: 700;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            margin-bottom: 8px;
        }
        .header-subtitle { color: #718096; font-size: 0.875rem; }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 24px;
            margin-bottom: 32px;
        }
        .stat-card {
            background: white;
            border-radius: 20px;
            padding: 24px;
            transition: transform 0.2s;
            box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
        }
        .stat-card:hover { transform: translateY(-4px); }
        .stat-icon {
            width: 48px;
            height: 48px;
            border-radius: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            margin-bottom: 16px;
        }
        .stat-icon.blue { background: rgba(59, 130, 246, 0.1); color: #3b82f6; }
        .stat-icon.purple { background: rgba(139, 92, 246, 0.1); color: #8b5cf6; }
        .stat-icon.green { background: rgba(16, 185, 129, 0.1); color: #10b981; }
        .stat-value { font-size: 2rem; font-weight: 700; margin-bottom: 8px; }
        .stat-label { color: #718096; font-size: 0.875rem; font-weight: 500; }
        .stat-sub { font-size: 0.75rem; color: #a0aec0; margin-top: 4px; }
        .section-title {
            font-size: 1.5rem;
            font-weight: 600;
            margin-bottom: 24px;
            display: flex;
            align-items: center;
            gap: 12px;
            color: white;
        }
        .table-container {
            background: white;
            border-radius: 20px;
            overflow-x: auto;
            margin-bottom: 32px;
            box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
        }
        table { width: 100%; border-collapse: collapse; }
        thead { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
        th, td { padding: 16px 20px; text-align: left; }
        td { border-bottom: 1px solid #e2e8f0; }
        tr:hover { background: #f7fafc; }
        .badge {
            display: inline-flex;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.75rem;
            font-weight: 600;
            background: rgba(102, 126, 234, 0.1);
            color: #667eea;
        }
        .trend-up { color: #10b981; font-weight: 600; }
        .progress-bar { width: 100px; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); transition: width 0.3s; }
        .loading { text-align: center; padding: 48px; color: #718096; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .live-indicator {
            display: inline-block;
            width: 8px;
            height: 8px;
            background: #10b981;
            border-radius: 50%;
            animation: pulse 2s infinite;
            margin-right: 8px;
        }
        .footer { text-align: center; padding: 24px; color: white; font-size: 0.875rem; }
        .status-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.75rem;
            font-weight: 600;
            background: #d1fae5;
            color: #065f46;
            margin-left: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><i class="fab fa-docker"></i> Docker Hub Metrics Dashboard</h1>
            <div class="header-subtitle">
                Monitoring ${NAMESPACES.length} namespaces | Real-time pull statistics
                <span class="status-badge" id="statusBadge">🟢 Live</span>
            </div>
        </div>

        <div class="stats-grid" id="statsGrid">
            <div class="loading"><i class="fas fa-spinner fa-pulse"></i> Loading statistics...</div>
        </div>

        <div class="section-title">
            <i class="fas fa-chart-line"></i>
            <span>Recent Activity</span>
            <span class="live-indicator"></span>
            <span id="lastUpdateText" style="font-size: 0.875rem; opacity: 0.9;"></span>
        </div>

        <div class="table-container">
            <table id="changesTable">
                <thead><tr><th>Image</th><th>Namespace</th><th>New Pulls</th><th>Time</th></tr></thead>
                <tbody id="changesBody">
                    <tr><td colspan="4" class="loading">Loading...</td></tr>
                </tbody>
            </table>
        </div>

        <div class="section-title">
            <i class="fas fa-ranking-star"></i>
            <span>All Images by Pull Count</span>
        </div>

        <div class="table-container">
            <table id="imagesTable">
                <thead><tr><th>#</th><th>Image Name</th><th>Namespace</th><th>Pull Count</th><th>Activity</th></tr></thead>
                <tbody id="imagesBody">
                    <tr><td colspan="5" class="loading">Loading...</td></tr>
                </tbody>
            </table>
        </div>

        <div class="footer">
            <i class="fas fa-sync-alt"></i> Auto-refreshes every 3 seconds | Data from Docker Hub API
        </div>
    </div>

    <script>
        async function fetchMetrics() {
            try {
                const response = await fetch('/api/metrics');
                const result = await response.json();
                
                if (result.success && result.data) {
                    updateUI(result.data);
                    document.getElementById('statusBadge').innerHTML = '🟢 Live';
                }
            } catch (error) {
                console.error('Error:', error);
                document.getElementById('statusBadge').innerHTML = '🔴 Connecting...';
            }
        }
        
        function formatNumber(num) {
            return new Intl.NumberFormat().format(num || 0);
        }
        
        function formatTime(date) {
            if (!date) return 'Never';
            const now = new Date();
            const diff = Math.floor((now - new Date(date)) / 1000);
            if (diff < 5) return 'Just now';
            if (diff < 60) return diff + 's ago';
            if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
            if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
            return Math.floor(diff / 86400) + 'd ago';
        }
        
        function updateUI(data) {
            // Stats Grid
            const statsHtml = [];
            
            statsHtml.push('<div class="stat-card"><div class="stat-icon blue"><i class="fas fa-images"></i></div>');
            statsHtml.push('<div class="stat-value">' + data.totalImages + '</div>');
            statsHtml.push('<div class="stat-label">Total Images</div></div>');
            
            statsHtml.push('<div class="stat-card"><div class="stat-icon purple"><i class="fas fa-download"></i></div>');
            statsHtml.push('<div class="stat-value">' + formatNumber(data.totalPulls) + '</div>');
            statsHtml.push('<div class="stat-label">Total Pulls</div></div>');
            
            for (const [ns, stats] of Object.entries(data.namespaceStats || {})) {
                statsHtml.push('<div class="stat-card"><div class="stat-icon green"><i class="fas fa-cube"></i></div>');
                statsHtml.push('<div class="stat-value">' + stats.imageCount + '</div>');
                statsHtml.push('<div class="stat-label">' + ns + '</div>');
                statsHtml.push('<div class="stat-sub">' + formatNumber(stats.totalPulls) + ' pulls</div></div>');
            }
            
            document.getElementById('statsGrid').innerHTML = statsHtml.join('');
            document.getElementById('lastUpdateText').innerHTML = 'Last updated: ' + formatTime(data.lastUpdate);
            
            // Recent Changes
            const changes = data.recentChanges || [];
            const changesBody = document.getElementById('changesBody');
            if (changes.length === 0) {
                changesBody.innerHTML = '<tr><td colspan="4" class="loading">No recent changes</td></tr>';
            } else {
                changesBody.innerHTML = changes.slice(0, 10).map(c => `
                    <tr>
                        <td><strong>${escapeHtml(c.name)}</strong></td>
                        <td><span class="badge">${escapeHtml(c.namespace)}</span></td>
                        <td class="trend-up">+${c.diff.toLocaleString()} pulls</td>
                        <td>${formatTime(c.timestamp)}</td>
                    </tr>
                `).join('');
            }
            
            // Images Table
            const images = data.images || [];
            const imagesBody = document.getElementById('imagesBody');
            const maxPulls = images.length > 0 ? images[0].pullCount : 1;
            
            if (images.length === 0) {
                imagesBody.innerHTML = '<tr><td colspan="5" class="loading">No images found</td></tr>';
            } else {
                imagesBody.innerHTML = images.slice(0, 100).map((img, idx) => {
                    const percent = (img.pullCount / maxPulls) * 100;
                    return `
                        <tr>
                            <td>${idx + 1}</td>
                            <td><strong>${escapeHtml(img.name)}</strong></td>
                            <td><span class="badge">${escapeHtml(img.namespace)}</span></td>
                            <td>${formatNumber(img.pullCount)}</td>
                            <td><div class="progress-bar"><div class="progress-fill" style="width: ${percent}%"></div></div></td>
                        </tr>
                    `;
                }).join('');
            }
        }
        
        function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        // Load immediately and every 3 seconds
        fetchMetrics();
        setInterval(fetchMetrics, 3000);
    </script>
</body>
</html>
  `);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✨ Dashboard running!`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`📊 Monitoring ${NAMESPACES.length} namespaces`);
  console.log(`🔄 Fetching real data from Docker Hub...\n`);
  
  // Start background updates
  updateData();
  setInterval(updateData, 60000); // Update every minute
});

console.log(`\n⏳ Waiting for requests...`);
  process.exit(0);
});
