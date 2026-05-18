const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const NAMESPACES = process.env.NAMESPACES 
  ? process.env.NAMESPACES.split(',') 
  : ['phemextradebot', 'linux84744474', 'linux88884474', 'webapps84', 'tradingbotapp', 'webcoder4', 'weblinux84', 'tradepackage'];
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 15000; // 15 seconds default

let cachedData = {
  images: [],
  lastUpdate: null,
  totalPulls: 0,
  totalImages: 0,
  namespaceStats: {},
  trends: {},
  changes: [],
  previousChanges: []
};

let previousSnapshot = new Map();

// Fetch helper with timeout
async function fetchJSON(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Request timeout'));
    }, timeout);
    
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

async function getAllRepositories(namespace) {
  let allRepos = [];
  let url = `https://hub.docker.com/v2/repositories/${namespace}/?page_size=100`;
  
  while (url) {
    try {
      const data = await fetchJSON(url);
      allRepos = allRepos.concat(data.results || []);
      url = data.next || null;
    } catch (error) {
      console.error(`Error fetching repositories for ${namespace}: ${error.message}`);
      break;
    }
  }
  
  return allRepos;
}

async function getImagePullCount(fullName) {
  try {
    const data = await fetchJSON(`https://hub.docker.com/v2/repositories/${fullName}`);
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
  
  for (const namespace of NAMESPACES) {
    try {
      const repositories = await getAllRepositories(namespace);
      
      for (const repo of repositories) {
        const repoName = repo.name;
        const fullName = `${namespace}/${repoName}`;
        const data = await getImagePullCount(fullName);
        
        if (data.exists) {
          const imageData = {
            name: repoName,
            namespace: namespace,
            fullName: fullName,
            pullCount: data.pullCount,
            lastUpdated: data.lastUpdated,
            lastUpdatedDate: new Date(data.lastUpdated)
          };
          
          // Check for changes
          const previous = previousSnapshot.get(fullName);
          if (previous && previous !== data.pullCount) {
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
        
        await new Promise(resolve => setTimeout(resolve, 50)); // Rate limiting
      }
    } catch (error) {
      console.error(`Error processing namespace ${namespace}:`, error.message);
    }
  }
  
  // Sort by pull count
  allImages.sort((a, b) => b.pullCount - a.pullCount);
  
  // Calculate totals by namespace
  const namespaceStats = {};
  for (const namespace of NAMESPACES) {
    const nsImages = allImages.filter(img => img.namespace === namespace);
    namespaceStats[namespace] = {
      totalPulls: nsImages.reduce((sum, img) => sum + img.pullCount, 0),
      imageCount: nsImages.length,
      topImage: nsImages[0] || null
    };
  }
  
  const totalPulls = allImages.reduce((sum, img) => sum + img.pullCount, 0);
  
  return {
    images: allImages,
    totalPulls: totalPulls,
    totalImages: allImages.length,
    namespaceStats: namespaceStats,
    changes: changes.slice(0, 10),
    lastUpdate: new Date()
  };
}

// Background data updater
async function updateData() {
  try {
    console.log(`[${new Date().toISOString()}] Fetching latest Docker Hub data...`);
    const newData = await fetchAllData();
    
    // Merge with existing trends
    const updatedTrends = { ...cachedData.trends };
    for (const change of newData.changes) {
      const trendKey = change.fullName;
      updatedTrends[trendKey] = (updatedTrends[trendKey] || 0) + change.diff;
    }
    
    const updatedChanges = [...(cachedData.previousChanges || []), ...newData.changes];
    
    cachedData = {
      ...newData,
      trends: updatedTrends,
      previousChanges: updatedChanges.slice(-50) // Keep last 50 changes
    };
    
    console.log(`✅ Data updated: ${cachedData.totalImages} images, ${cachedData.totalPulls.toLocaleString()} total pulls`);
  } catch (error) {
    console.error('Error updating data:', error.message);
  }
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API Routes
app.get('/api/metrics', (req, res) => {
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    data: {
      images: cachedData.images,
      totalPulls: cachedData.totalPulls,
      totalImages: cachedData.totalImages,
      namespaceStats: cachedData.namespaceStats,
      recentChanges: cachedData.previousChanges?.slice(-20) || [],
      trends: cachedData.trends,
      lastUpdate: cachedData.lastUpdate
    }
  });
});

app.get('/api/trending', (req, res) => {
  const trending = Object.entries(cachedData.trends || {})
    .map(([fullName, diff]) => {
      const image = cachedData.images.find(img => img.fullName === fullName);
      return {
        fullName,
        diff,
        pullCount: image?.pullCount || 0,
        namespace: image?.namespace,
        name: image?.name
      };
    })
    .sort((a, b) => b.diff - a.diff)
    .slice(0, 10);
  
  res.json({ success: true, trending, timestamp: new Date().toISOString() });
});

app.get('/api/namespace/:namespace', (req, res) => {
  const namespaceImages = cachedData.images.filter(
    img => img.namespace === req.params.namespace
  );
  res.json({
    success: true,
    namespace: req.params.namespace,
    images: namespaceImages,
    totalPulls: namespaceImages.reduce((sum, img) => sum + img.pullCount, 0),
    imageCount: namespaceImages.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    namespaces: NAMESPACES,
    lastUpdate: cachedData.lastUpdate,
    totalImages: cachedData.totalImages
  });
});

// Main HTML page
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
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
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
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
            box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
            margin-bottom: 32px;
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
            align-items: center;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.75rem;
            font-weight: 600;
        }

        .badge-primary {
            background: rgba(102, 126, 234, 0.1);
            color: #667eea;
        }

        .trend-up {
            color: #10b981;
            font-weight: 600;
        }

        .trend-down {
            color: #ef4444;
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
            border-radius: 3px;
            transition: width 0.3s;
        }

        .loading {
            text-align: center;
            padding: 48px;
            color: #718096;
        }

        @media (max-width: 768px) {
            .container {
                padding: 16px;
            }
            
            th, td {
                padding: 12px;
                font-size: 0.875rem;
            }
            
            .stat-value {
                font-size: 1.5rem;
            }
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
        
        .refresh-btn {
            background: white;
            border: none;
            padding: 8px 16px;
            border-radius: 12px;
            cursor: pointer;
            font-weight: 600;
            margin-left: auto;
            transition: transform 0.2s;
        }
        
        .refresh-btn:hover {
            transform: scale(1.05);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>
                <i class="fab fa-docker"></i>
                Docker Hub Metrics
            </h1>
            <div class="header-subtitle">
                Real-time pull statistics for multiple namespaces
            </div>
        </div>

        <div class="stats-grid" id="statsGrid">
            <div class="loading">Loading statistics...</div>
        </div>

        <div class="section-title">
            <i class="fas fa-chart-line"></i>
            <span>Recent Activity</span>
            <span class="live-indicator"></span>
            <span style="font-size: 0.875rem; font-weight: normal; opacity: 0.9;" id="lastUpdate">Updating...</span>
        </div>

        <div class="table-container">
            <table id="recentChangesTable">
                <thead>
                    <tr><th>Image</th><th>Namespace</th><th>New Pulls</th><th>Time</th></tr>
                </thead>
                <tbody>
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
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Image Name</th>
                        <th>Namespace</th>
                        <th>Pull Count</th>
                        <th>24h Trend</th>
                        <th>Activity</th>
                    </tr>
                </thead>
                <tbody>
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

        async function fetchMetrics() {
            try {
                const response = await fetch('/api/metrics');
                const result = await response.json();
                if (result.success) {
                    metricsData = result.data;
                    updateDashboard();
                }
            } catch (error) {
                console.error('Error fetching metrics:', error);
            }
        }

        function formatNumber(num) {
            return new Intl.NumberFormat().format(num);
        }

        function formatRelativeTime(date) {
            if (!date) return 'Never';
            const now = new Date();
            const diff = Math.floor((now - new Date(date)) / 1000);
            
            if (diff < 60) return \`\${diff} seconds ago\`;
            if (diff < 3600) return \`\${Math.floor(diff / 60)} minutes ago\`;
            if (diff < 86400) return \`\${Math.floor(diff / 3600)} hours ago\`;
            return \`\${Math.floor(diff / 86400)} days ago\`;
        }

        function updateStatsGrid() {
            if (!metricsData) return;
            
            const statsHtml = \`
                <div class="stat-card">
                    <div class="stat-icon blue">
                        <i class="fas fa-images"></i>
                    </div>
                    <div class="stat-value">\${metricsData.totalImages}</div>
                    <div class="stat-label">Total Images</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon purple">
                        <i class="fas fa-download"></i>
                    </div>
                    <div class="stat-value">\${formatNumber(metricsData.totalPulls)}</div>
                    <div class="stat-label">Total Pulls (All Time)</div>
                </div>
                \${Object.entries(metricsData.namespaceStats || {}).map(([ns, stats]) => \`
                    <div class="stat-card">
                        <div class="stat-icon green">
                            <i class="fas fa-cube"></i>
                        </div>
                        <div class="stat-value">\${stats.imageCount}</div>
                        <div class="stat-label">\${ns} Images</div>
                        <div style="margin-top: 8px; font-size: 0.875rem; color: #718096;">
                            \${formatNumber(stats.totalPulls)} pulls
                        </div>
                    </div>
                \`).join('')}
            \`;
            
            document.getElementById('statsGrid').innerHTML = statsHtml;
            document.getElementById('lastUpdate').innerHTML = \`Last updated: \${formatRelativeTime(metricsData.lastUpdate)}\`;
        }

        function updateRecentChanges() {
            const tbody = document.querySelector('#recentChangesTable tbody');
            const changes = metricsData?.recentChanges || [];
            
            if (changes.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">No recent changes detected</td></tr>';
                return;
            }
            
            tbody.innerHTML = changes.slice(-10).reverse().map(change => \`
                <tr>
                    <td><strong>\${change.name}</strong></td>
                    <td><span class="badge badge-primary">\${change.namespace}</span></td>
                    <td class="trend-up">+\${change.diff} pulls</td>
                    <td>\${formatRelativeTime(change.timestamp)}</td>
                </tr>
            \`).join('');
        }

        function updateImagesTable() {
            const tbody = document.querySelector('#imagesTable tbody');
            const images = metricsData?.images || [];
            const trends = metricsData?.trends || {};
            const maxPulls = images[0]?.pullCount || 1;
            
            if (images.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No images found</td></tr>';
                return;
            }
            
            tbody.innerHTML = images.slice(0, 50).map((image, index) => {
                const trend = trends[image.fullName] || 0;
                const trendClass = trend > 0 ? 'trend-up' : trend < 0 ? 'trend-down' : '';
                const trendIcon = trend > 0 ? '↑' : trend < 0 ? '↓' : '→';
                const percentage = (image.pullCount / maxPulls) * 100;
                
                return \`
                    <tr>
                        <td>\${index + 1}</td>
                        <td><strong>\${image.name}</strong></td>
                        <td><span class="badge badge-primary">\${image.namespace}</span></td>
                        <td>\${formatNumber(image.pullCount)}</td>
                        <td class="\${trendClass}">\${trendIcon} \${Math.abs(trend)}</td>
                        <td>
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: \${percentage}%"></div>
                            </div>
                        </td>
                    </tr>
                \`;
            }).join('');
        }

        function updateDashboard() {
            updateStatsGrid();
            updateRecentChanges();
            updateImagesTable();
        }

        // Auto-refresh every 5 seconds
        setInterval(fetchMetrics, 5000);
        
        // Initial load
        fetchMetrics();
    </script>
</body>
</html>
  `);
});

// Start server and background updater
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Docker Hub Metrics Dashboard`);
  console.log(`================================`);
  console.log(`📍 Server running on http://0.0.0.0:${PORT}`);
  console.log(`📊 Monitoring namespaces: ${NAMESPACES.join(', ')}`);
  console.log(`⏱️  Check interval: ${CHECK_INTERVAL / 1000} seconds`);
  console.log(`================================`);
  
  // Initial data fetch
  updateData();
  
  // Periodic updates
  setInterval(updateData, CHECK_INTERVAL);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});
