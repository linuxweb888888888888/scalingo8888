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
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 20000;

console.log(`========================================`);
console.log(`🚀 Docker Hub Metrics Dashboard`);
console.log(`========================================`);
console.log(`📋 Total namespaces: ${NAMESPACES.length}`);
console.log(`📋 Namespaces: ${NAMESPACES.join(', ')}`);
console.log(`⏱️  Check interval: ${CHECK_INTERVAL / 1000}s`);
console.log(`========================================\n`);

// Cache with initial empty state
let cachedData = {
  images: [],
  lastUpdate: new Date(),
  totalPulls: 0,
  totalImages: 0,
  namespaceStats: {},
  trends: {},
  changes: [],
  previousChanges: [],
  isStable: false,
  validNamespaces: [],
  lastSuccessfulUpdate: null
};

let previousSnapshot = new Map();
let isUpdating = false;
let firstUpdateDone = false;

// Fetch helper with timeout
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

async function checkNamespaceExists(namespace) {
  try {
    const url = `https://hub.docker.com/v2/repositories/${namespace}/?page_size=1`;
    const data = await fetchJSON(url, 5000);
    const hasRepos = data.results && data.results.length > 0;
    const count = data.count || 0;
    
    return {
      exists: true,
      hasRepositories: hasRepos,
      repositoryCount: count
    };
  } catch (error) {
    return {
      exists: false,
      hasRepositories: false,
      repositoryCount: 0
    };
  }
}

async function getAllRepositories(namespace) {
  let allRepos = [];
  let url = `https://hub.docker.com/v2/repositories/${namespace}/?page_size=100`;
  
  while (url) {
    try {
      const data = await fetchJSON(url);
      if (data.results && data.results.length > 0) {
        allRepos = allRepos.concat(data.results);
        url = data.next || null;
      } else {
        break;
      }
    } catch (error) {
      break;
    }
  }
  
  return allRepos;
}

async function getImagePullCount(fullName) {
  try {
    const data = await fetchJSON(`https://hub.docker.com/v2/repositories/${fullName}`, 8000);
    return {
      pullCount: data.pull_count || 0,
      lastUpdated: data.last_updated || data.pushed_at || new Date().toISOString(),
      exists: true
    };
  } catch (error) {
    return {
      pullCount: 0,
      lastUpdated: null,
      exists: false
    };
  }
}

async function fetchAllData() {
  const allImages = [];
  const changes = [];
  const validNamespaces = [];
  
  // Find valid namespaces
  for (const namespace of NAMESPACES) {
    const status = await checkNamespaceExists(namespace);
    if (status.hasRepositories) {
      validNamespaces.push(namespace);
    }
  }
  
  // Fetch images from valid namespaces
  for (const namespace of validNamespaces) {
    try {
      const repositories = await getAllRepositories(namespace);
      
      for (const repo of repositories) {
        const repoName = repo.name;
        const fullName = `${namespace}/${repoName}`;
        const data = await getImagePullCount(fullName);
        
        if (data.exists && data.pullCount > 0) {
          const imageData = {
            name: repoName,
            namespace: namespace,
            fullName: fullName,
            pullCount: data.pullCount,
            lastUpdated: data.lastUpdated
          };
          
          // Check for changes
          const previous = previousSnapshot.get(fullName);
          if (previous !== undefined && previous !== data.pullCount && data.pullCount > previous) {
            const diff = data.pullCount - previous;
            changes.push({
              ...imageData,
              diff: diff,
              timestamp: new Date()
            });
          }
          
          previousSnapshot.set(fullName, data.pullCount);
          allImages.push(imageData);
        }
        
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } catch (error) {
      console.error(`Error fetching ${namespace}:`, error.message);
    }
  }
  
  // Sort by pull count
  allImages.sort((a, b) => b.pullCount - a.pullCount);
  
  // Calculate namespace stats
  const namespaceStats = {};
  for (const namespace of validNamespaces) {
    const nsImages = allImages.filter(img => img.namespace === namespace);
    if (nsImages.length > 0) {
      namespaceStats[namespace] = {
        totalPulls: nsImages.reduce((sum, img) => sum + img.pullCount, 0),
        imageCount: nsImages.length,
        topImage: nsImages[0]?.name || 'None',
        topImagePulls: nsImages[0]?.pullCount || 0
      };
    }
  }
  
  const totalPulls = allImages.reduce((sum, img) => sum + img.pullCount, 0);
  
  return {
    images: allImages,
    totalPulls: totalPulls,
    totalImages: allImages.length,
    namespaceStats: namespaceStats,
    changes: changes,
    lastUpdate: new Date(),
    validNamespaces: validNamespaces.filter(ns => namespaceStats[ns])
  };
}

async function updateData() {
  if (isUpdating) return;
  
  isUpdating = true;
  
  try {
    console.log(`[${new Date().toISOString()}] Fetching data...`);
    const newData = await fetchAllData();
    
    if (newData.images && newData.images.length > 0) {
      // Update trends
      const updatedTrends = { ...cachedData.trends };
      for (const change of newData.changes) {
        updatedTrends[change.fullName] = (updatedTrends[change.fullName] || 0) + change.diff;
      }
      
      const updatedChanges = [...newData.changes, ...(cachedData.previousChanges || [])].slice(0, 100);
      
      cachedData = {
        images: newData.images,
        totalPulls: newData.totalPulls,
        totalImages: newData.totalImages,
        namespaceStats: newData.namespaceStats,
        trends: updatedTrends,
        changes: newData.changes,
        previousChanges: updatedChanges,
        lastUpdate: newData.lastUpdate,
        isStable: true,
        validNamespaces: newData.validNamespaces,
        lastSuccessfulUpdate: new Date()
      };
      
      console.log(`✅ Updated: ${newData.totalImages} images, ${newData.totalPulls.toLocaleString()} pulls from ${Object.keys(newData.namespaceStats).length} namespaces`);
      firstUpdateDone = true;
    } else if (!firstUpdateDone) {
      console.log('⏳ Waiting for first valid data...');
    } else {
      console.log('⚠️ No new data, keeping cache');
    }
  } catch (error) {
    console.error('❌ Update error:', error.message);
  } finally {
    isUpdating = false;
  }
}

// Middleware
app.use(express.json());

// API endpoint
app.get('/api/metrics', (req, res) => {
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    data: {
      images: cachedData.images || [],
      totalPulls: cachedData.totalPulls || 0,
      totalImages: cachedData.totalImages || 0,
      namespaceStats: cachedData.namespaceStats || {},
      recentChanges: cachedData.previousChanges?.slice(0, 20) || [],
      trends: cachedData.trends || {},
      lastUpdate: cachedData.lastUpdate,
      isStable: cachedData.isStable,
      validNamespaces: cachedData.validNamespaces || []
    }
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: cachedData.isStable ? 'healthy' : 'starting',
    uptime: process.uptime(),
    totalImages: cachedData.totalImages,
    totalPulls: cachedData.totalPulls,
    lastUpdate: cachedData.lastUpdate,
    validNamespaces: cachedData.validNamespaces
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
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
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
        .info-note {
            background: #e0e7ff;
            padding: 12px 20px;
            border-radius: 12px;
            margin-bottom: 24px;
            font-size: 0.875rem;
            color: #3730a3;
        }
        .refresh-btn {
            background: white;
            border: none;
            padding: 8px 16px;
            border-radius: 12px;
            cursor: pointer;
            font-weight: 600;
            margin-left: auto;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><i class="fab fa-docker"></i> Docker Hub Metrics Dashboard</h1>
            <div class="header-subtitle">Monitoring ${NAMESPACES.length} namespaces | Real-time pull statistics</div>
        </div>
        
        <div class="info-note" id="infoNote">
            <i class="fas fa-spinner fa-pulse"></i> Loading data from Docker Hub...
        </div>

        <div class="stats-grid" id="statsGrid">
            <div class="loading"><i class="fas fa-spinner fa-pulse"></i> Loading statistics...</div>
        </div>

        <div class="section-title">
            <i class="fas fa-chart-line"></i>
            <span>Recent Activity</span>
            <span class="live-indicator"></span>
            <span style="font-size: 0.875rem; opacity: 0.9;" id="lastUpdate">Loading...</span>
        </div>

        <div class="table-container">
            <table id="recentChangesTable">
                <thead><tr><th>Image</th><th>Namespace</th><th>New Pulls</th><th>Time</th></tr></thead>
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
            <table id="imagesTable">
                <thead><tr><th>#</th><th>Image Name</th><th>Namespace</th><th>Pull Count</th><th>Trend</th><th>Activity</th></tr></thead>
                <tbody id="imagesBody">
                    <tr><td colspan="6" class="loading">Loading...</td></tr>
                </tbody>
            </table>
        </div>
        
        <div class="footer">
            <i class="fas fa-sync-alt"></i> Auto-refreshes every 5 seconds | Data from Docker Hub API
        </div>
    </div>

    <script>
        let metricsData = null;
        let refreshCount = 0;
        
        async function fetchMetrics() {
            try {
                const response = await fetch('/api/metrics');
                const result = await response.json();
                if (result.success && result.data) {
                    metricsData = result.data;
                    updateDashboard();
                    refreshCount = 0;
                }
            } catch (error) {
                console.error('Error:', error);
                refreshCount++;
                if (refreshCount > 3) {
                    document.getElementById('infoNote').innerHTML = '<i class="fas fa-exclamation-triangle"></i> Connection issues, retrying...';
                }
            }
        }
        
        function formatNumber(num) {
            if (num === undefined || num === null) return '0';
            return new Intl.NumberFormat().format(num);
        }
        
        function formatRelativeTime(date) {
            if (!date) return 'Just now';
            const now = new Date();
            const diff = Math.floor((now - new Date(date)) / 1000);
            if (diff < 5) return 'Just now';
            if (diff < 60) return \`\${diff} seconds ago\`;
            if (diff < 3600) return \`\${Math.floor(diff / 60)} minutes ago\`;
            if (diff < 86400) return \`\${Math.floor(diff / 3600)} hours ago\`;
            return \`\${Math.floor(diff / 86400)} days ago\`;
        }
        
        function updateDashboard() {
            if (!metricsData) return;
            
            // Update info note
            const namespaceCount = Object.keys(metricsData.namespaceStats || {}).length;
            if (metricsData.totalImages > 0) {
                document.getElementById('infoNote').innerHTML = \`
                    <i class="fas fa-check-circle"></i> 
                    Found \${metricsData.totalImages} images across \${namespaceCount} namespaces | 
                    Last scan: \${formatRelativeTime(metricsData.lastUpdate)}
                \`;
            }
            
            // Update stats grid
            const statsHtml = [
                '<div class="stat-card"><div class="stat-icon blue"><i class="fas fa-images"></i></div>',
                '<div class="stat-value">' + formatNumber(metricsData.totalImages) + '</div>',
                '<div class="stat-label">Total Images</div></div>',
                '<div class="stat-card"><div class="stat-icon purple"><i class="fas fa-download"></i></div>',
                '<div class="stat-value">' + formatNumber(metricsData.totalPulls) + '</div>',
                '<div class="stat-label">Total Pulls (All Time)</div></div>'
            ].join('');
            
            const namespaceStats = metricsData.namespaceStats || {};
            for (const [ns, stats] of Object.entries(namespaceStats)) {
                statsHtml.push(\`
                    <div class="stat-card">
                        <div class="stat-icon green"><i class="fas fa-cube"></i></div>
                        <div class="stat-value">\${stats.imageCount}</div>
                        <div class="stat-label">\${ns}</div>
                        <div class="stat-sub">\${formatNumber(stats.totalPulls)} pulls</div>
                    </div>
                \`);
            }
            
            document.getElementById('statsGrid').innerHTML = statsHtml;
            document.getElementById('lastUpdate').innerHTML = \`Last updated: \${formatRelativeTime(metricsData.lastUpdate)}\`;
            
            // Update recent changes
            const changes = metricsData.recentChanges || [];
            const changesBody = document.getElementById('recentChangesBody');
            if (changes.length === 0) {
                changesBody.innerHTML = '<tr><td colspan="4" style="text-align: center;">No recent changes detected</td></tr>';
            } else {
                changesBody.innerHTML = changes.slice(0, 10).map(change => \`
                    <tr>
                        <td><strong>\${escapeHtml(change.name || 'Unknown')}</strong></td>
                        <td><span class="badge">\${escapeHtml(change.namespace || 'Unknown')}</span></td>
                        <td class="trend-up">+\${change.diff || 0} pulls</td>
                        <td>\${formatRelativeTime(change.timestamp)}</td>
                    </tr>
                \`).join('');
            }
            
            // Update images table
            const images = metricsData.images || [];
            const trends = metricsData.trends || {};
            const maxPulls = images.length > 0 ? images[0].pullCount : 1;
            const imagesBody = document.getElementById('imagesBody');
            
            if (images.length === 0) {
                imagesBody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No images found - loading...</td></tr>';
            } else {
                imagesBody.innerHTML = images.slice(0, 100).map((image, index) => {
                    const trend = trends[image.fullName] || 0;
                    const trendIcon = trend > 0 ? '↑' : '→';
                    const percentage = (image.pullCount / maxPulls) * 100;
                    return \`
                        <tr>
                            <td>\${index + 1}</td>
                            <td><strong>\${escapeHtml(image.name)}</strong></td>
                            <td><span class="badge">\${escapeHtml(image.namespace)}</span></td>
                            <td>\${formatNumber(image.pullCount)}</td>
                            <td class="trend-up">\${trendIcon} \${Math.abs(trend)}</td>
                            <td><div class="progress-bar"><div class="progress-fill" style="width: \${percentage}%"></div></div></td>
                        </tr>
                    \`;
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
        fetchMetrics();
        
        // Auto-refresh every 3 seconds
        setInterval(fetchMetrics, 3000);
    </script>
</body>
</html>
  `);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server running on http://0.0.0.0:${PORT}`);
  console.log(`📊 Monitoring ${NAMESPACES.length} namespaces`);
  console.log(`⏱️  Update interval: ${CHECK_INTERVAL / 1000}s`);
  console.log(`========================================\n`);
  
  // Initial update
  updateData();
  
  // Periodic updates
  setInterval(updateData, CHECK_INTERVAL);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  process.exit(0);
});
