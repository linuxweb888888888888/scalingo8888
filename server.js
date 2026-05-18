const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// All namespaces to check
const ALL_NAMESPACES = [
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

// Remove duplicates
const NAMESPACES = [...new Set(ALL_NAMESPACES)].filter(ns => ns && ns.trim());
const CHECK_INTERVAL = 30000; // 30 seconds

console.log(`========================================`);
console.log(`🚀 Docker Hub Metrics Dashboard`);
console.log(`========================================`);
console.log(`📋 Total namespaces: ${NAMESPACES.length}`);
console.log(`⏱️  Check interval: ${CHECK_INTERVAL / 1000}s`);
console.log(`========================================\n`);

// Initialize cache with default data
let cachedData = {
  images: [],
  totalPulls: 0,
  totalImages: 0,
  namespaceStats: {},
  recentChanges: [],
  lastUpdate: new Date(),
  isReady: false
};

let previousPullCounts = new Map();
let isUpdating = false;

// Fetch helper
async function fetchJSON(url, timeout = 10000) {
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

// Get all repositories for a namespace
async function getRepositories(namespace) {
  try {
    const url = `https://hub.docker.com/v2/repositories/${namespace}/?page_size=100`;
    const data = await fetchJSON(url, 8000);
    return data.results || [];
  } catch (error) {
    console.log(`  ⚠️ No repos found for ${namespace}`);
    return [];
  }
}

// Get pull count for a specific image
async function getPullCount(namespace, image) {
  try {
    const url = `https://hub.docker.com/v2/repositories/${namespace}/${image}`;
    const data = await fetchJSON(url, 5000);
    return data.pull_count || 0;
  } catch (error) {
    return 0;
  }
}

// Main data fetch function
async function fetchAllData() {
  const allImages = [];
  const changes = [];
  
  console.log(`\n🔍 Scanning ${NAMESPACES.length} namespaces...`);
  
  for (const namespace of NAMESPACES) {
    console.log(`  Checking: ${namespace}`);
    const repos = await getRepositories(namespace);
    
    if (repos.length === 0) {
      console.log(`    ❌ No public repositories`);
      continue;
    }
    
    console.log(`    ✅ Found ${repos.length} repositories`);
    
    for (const repo of repos) {
      const imageName = repo.name;
      const pullCount = await getPullCount(namespace, imageName);
      
      if (pullCount > 0) {
        const fullName = `${namespace}/${imageName}`;
        const previousCount = previousPullCounts.get(fullName) || 0;
        
        if (previousCount > 0 && pullCount > previousCount) {
          const diff = pullCount - previousCount;
          changes.push({
            name: imageName,
            namespace: namespace,
            fullName: fullName,
            diff: diff,
            newCount: pullCount,
            timestamp: new Date()
          });
          console.log(`      🔔 ${imageName}: +${diff} pulls`);
        }
        
        previousPullCounts.set(fullName, pullCount);
        
        allImages.push({
          name: imageName,
          namespace: namespace,
          fullName: fullName,
          pullCount: pullCount,
          lastUpdated: repo.last_updated || new Date().toISOString()
        });
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  // Sort by pull count
  allImages.sort((a, b) => b.pullCount - a.pullCount);
  
  // Calculate namespace stats
  const namespaceStats = {};
  for (const img of allImages) {
    if (!namespaceStats[img.namespace]) {
      namespaceStats[img.namespace] = {
        imageCount: 0,
        totalPulls: 0
      };
    }
    namespaceStats[img.namespace].imageCount++;
    namespaceStats[img.namespace].totalPulls += img.pullCount;
  }
  
  const totalPulls = allImages.reduce((sum, img) => sum + img.pullCount, 0);
  
  console.log(`\n📊 Summary: ${allImages.length} images, ${totalPulls.toLocaleString()} total pulls`);
  console.log(`📦 Namespaces with images: ${Object.keys(namespaceStats).join(', ') || 'none'}`);
  
  return {
    images: allImages,
    totalPulls: totalPulls,
    totalImages: allImages.length,
    namespaceStats: namespaceStats,
    recentChanges: changes.slice(0, 20),
    lastUpdate: new Date()
  };
}

// Background updater
async function updateData() {
  if (isUpdating) {
    console.log('⏳ Update already in progress...');
    return;
  }
  
  isUpdating = true;
  
  try {
    console.log(`\n[${new Date().toISOString()}] Starting data update...`);
    const newData = await fetchAllData();
    
    if (newData.totalImages > 0 || !cachedData.isReady) {
      cachedData = {
        ...newData,
        isReady: true
      };
      console.log(`✅ Cache updated successfully`);
    } else {
      console.log(`⚠️ No data received, keeping existing cache`);
    }
  } catch (error) {
    console.error(`❌ Update error:`, error.message);
  } finally {
    isUpdating = false;
  }
}

// Express middleware
app.use(express.json());

// API endpoint - always returns data
app.get('/api/metrics', (req, res) => {
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
      isReady: cachedData.isReady
    }
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: cachedData.isReady ? 'healthy' : 'starting',
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
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: #1a202c;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 24px;
        }

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

        .header-subtitle {
            color: #718096;
            font-size: 0.875rem;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 24px;
            margin-bottom: 32px;
        }

        .stat-card {
            background: white;
            border-radius: 20px;
            padding: 24px;
            transition: transform 0.2s, box-shadow 0.2s;
            box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
        }

        .stat-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
        }

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
        .stat-icon.orange { background: rgba(245, 158, 11, 0.1); color: #f59e0b; }

        .stat-value {
            font-size: 2rem;
            font-weight: 700;
            margin-bottom: 8px;
        }

        .stat-label {
            color: #718096;
            font-size: 0.875rem;
            font-weight: 500;
        }

        .stat-sub {
            font-size: 0.75rem;
            color: #a0aec0;
            margin-top: 4px;
        }

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

        table {
            width: 100%;
            border-collapse: collapse;
        }

        thead {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        th {
            padding: 16px 20px;
            text-align: left;
            font-weight: 600;
            font-size: 0.875rem;
        }

        td {
            padding: 16px 20px;
            border-bottom: 1px solid #e2e8f0;
        }

        tr:hover {
            background: #f7fafc;
        }

        .badge {
            display: inline-flex;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.75rem;
            font-weight: 600;
            background: rgba(102, 126, 234, 0.1);
            color: #667eea;
        }

        .trend-up {
            color: #10b981;
            font-weight: 600;
        }

        .progress-bar {
            width: 100px;
            height: 6px;
            background: #e2e8f0;
            border-radius: 3px;
            overflow: hidden;
        }

        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #667eea, #764ba2);
            transition: width 0.3s;
        }

        .loading {
            text-align: center;
            padding: 48px;
            color: #718096;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .live-indicator {
            display: inline-block;
            width: 8px;
            height: 8px;
            background: #10b981;
            border-radius: 50%;
            animation: pulse 2s infinite;
            margin-right: 8px;
        }

        .footer {
            text-align: center;
            padding: 24px;
            color: white;
            font-size: 0.875rem;
        }

        .info-card {
            background: #e0e7ff;
            padding: 12px 20px;
            border-radius: 12px;
            margin-bottom: 24px;
            font-size: 0.875rem;
            color: #3730a3;
        }

        .success-card {
            background: #d1fae5;
            color: #065f46;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><i class="fab fa-docker"></i> Docker Hub Metrics Dashboard</h1>
            <div class="header-subtitle">Monitoring ${NAMESPACES.length} namespaces | Real-time pull statistics</div>
        </div>

        <div id="statusCard" class="info-card">
            <i class="fas fa-spinner fa-pulse"></i> Loading data from Docker Hub...
        </div>

        <div class="stats-grid" id="statsGrid">
            <div class="loading">Loading statistics...</div>
        </div>

        <div class="section-title">
            <i class="fas fa-chart-line"></i>
            <span>Recent Activity</span>
            <span class="live-indicator"></span>
            <span id="lastUpdateText" style="font-size: 0.875rem; opacity: 0.9;"></span>
        </div>

        <div class="table-container">
            <table>
                <thead>
                    <tr><th>Image</th><th>Namespace</th><th>New Pulls</th><th>Time</th></tr>
                </thead>
                <tbody id="recentChangesBody">
                    <tr><td colspan="4" class="loading">Loading...</td></tr>
                </tbody>
            </table>
        </div>

        <div class="section-title">
            <i class="fas fa-ranking-star"></i>
            <span>All Images by Pull Count</span>
        </div>

        <div class="table-container">
            <table>
                <thead>
                    <tr><th>#</th><th>Image Name</th><th>Namespace</th><th>Pull Count</th><th>Activity</th></tr>
                </thead>
                <tbody id="imagesBody">
                    <tr><td colspan="5" class="loading">Loading...</td></tr>
                </tbody>
            </table>
        </div>

        <div class="footer">
            <i class="fas fa-sync-alt"></i> Auto-refreshes every 5 seconds | Data from Docker Hub API
        </div>
    </div>

    <script>
        let updateCount = 0;
        
        async function loadData() {
            try {
                const response = await fetch('/api/metrics');
                const result = await response.json();
                
                if (result.success && result.data) {
                    updateDashboard(result.data);
                    updateCount = 0;
                } else {
                    throw new Error('Invalid response');
                }
            } catch (error) {
                console.error('Error:', error);
                updateCount++;
                if (updateCount > 3) {
                    document.getElementById('statusCard').innerHTML = '<i class="fas fa-exclamation-triangle"></i> Connection issues, retrying...';
                }
                setTimeout(loadData, 2000);
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
            if (diff < 60) return diff + ' seconds ago';
            if (diff < 3600) return Math.floor(diff / 60) + ' minutes ago';
            if (diff < 86400) return Math.floor(diff / 3600) + ' hours ago';
            return Math.floor(diff / 86400) + ' days ago';
        }
        
        function updateDashboard(data) {
            // Update status card
            if (data.totalImages > 0) {
                const namespaces = Object.keys(data.namespaceStats).length;
                document.getElementById('statusCard').innerHTML = 
                    '<i class="fas fa-check-circle"></i> ✓ Found ' + data.totalImages + 
                    ' images across ' + namespaces + ' namespaces | ' +
                    formatNumber(data.totalPulls) + ' total pulls';
                document.getElementById('statusCard').className = 'info-card success-card';
            } else if (data.isReady) {
                document.getElementById('statusCard').innerHTML = 
                    '<i class="fas fa-info-circle"></i> No images found. Check Docker Hub namespaces.';
            }
            
            // Update last update time
            document.getElementById('lastUpdateText').innerHTML = 
                'Last updated: ' + formatTime(data.lastUpdate);
            
            // Update stats grid
            const statsHtml = [];
            
            // Total Images card
            statsHtml.push('<div class="stat-card"><div class="stat-icon blue"><i class="fas fa-images"></i></div>');
            statsHtml.push('<div class="stat-value">' + data.totalImages + '</div>');
            statsHtml.push('<div class="stat-label">Total Images</div></div>');
            
            // Total Pulls card
            statsHtml.push('<div class="stat-card"><div class="stat-icon purple"><i class="fas fa-download"></i></div>');
            statsHtml.push('<div class="stat-value">' + formatNumber(data.totalPulls) + '</div>');
            statsHtml.push('<div class="stat-label">Total Pulls</div></div>');
            
            // Namespace cards
            for (const [ns, stats] of Object.entries(data.namespaceStats || {})) {
                statsHtml.push('<div class="stat-card"><div class="stat-icon green"><i class="fas fa-cube"></i></div>');
                statsHtml.push('<div class="stat-value">' + stats.imageCount + '</div>');
                statsHtml.push('<div class="stat-label">' + ns + '</div>');
                statsHtml.push('<div class="stat-sub">' + formatNumber(stats.totalPulls) + ' pulls</div></div>');
            }
            
            document.getElementById('statsGrid').innerHTML = statsHtml.join('');
            
            // Update recent changes
            const changes = data.recentChanges || [];
            const changesBody = document.getElementById('recentChangesBody');
            if (changes.length === 0) {
                changesBody.innerHTML = '<tr><td colspan="4" class="loading">No recent changes detected</td></tr>';
            } else {
                changesBody.innerHTML = changes.slice(0, 10).map(change => `
                    <tr>
                        <td><strong>${escapeHtml(change.name)}</strong></td>
                        <td><span class="badge">${escapeHtml(change.namespace)}</span></td>
                        <td class="trend-up">+${change.diff} pulls</td>
                        <td>${formatTime(change.timestamp)}</td>
                    </tr>
                `).join('');
            }
            
            // Update images table
            const images = data.images || [];
            const imagesBody = document.getElementById('imagesBody');
            const maxPulls = images.length > 0 ? images[0].pullCount : 1;
            
            if (images.length === 0) {
                imagesBody.innerHTML = '<tr><td colspan="5" class="loading">No images found</td></tr>';
            } else {
                imagesBody.innerHTML = images.slice(0, 50).map((img, idx) => {
                    const percentage = (img.pullCount / maxPulls) * 100;
                    return `
                        <tr>
                            <td>${idx + 1}</td>
                            <td><strong>${escapeHtml(img.name)}</strong></td>
                            <td><span class="badge">${escapeHtml(img.namespace)}</span></td>
                            <td>${formatNumber(img.pullCount)}</td>
                            <td>
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: ${percentage}%"></div>
                                </div>
                            </td>
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
        
        // Initial load
        loadData();
        
        // Auto-refresh every 5 seconds
        setInterval(loadData, 5000);
    </script>
</body>
</html>
  `);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✨ Dashboard ready!`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`📊 Monitoring ${NAMESPACES.length} namespaces`);
  console.log(`🔄 First data fetch starting...\n`);
  
  // Start background updates
  updateData();
  setInterval(updateData, CHECK_INTERVAL);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  process.exit(0);
});
