const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// All namespaces to check
const NAMESPACES = [
  'phemextradebot', 'linux84744474', 'linux88884474', 'webapps84', 
  'tradingbotapp', 'webcoder4', 'weblinux84', 'tradepackage', 
  'hitbtctradebot', 'webwebwebwebwebweb', 'webpackage', 'clevertradebot', 
  'linux88888888', 'linuxlinuxlinuxlinux8888', 'tradeincbot', 
  'tradeincbotbot', 'buyrunplace'
];

// --- PERSISTENT DATA BEYOND REFRESHES ---
let pullCountHistory = new Map(); // Global memory of counts
let recentChangesLog = [];       // Global log of changes (Growth detected)

let cachedData = {
  images: [],
  totalPulls: 0,
  totalImages: 0,
  namespaceStats: {},
  lastUpdate: new Date(),
  isReady: false
};

let isUpdating = false;

// Fetch helper with timeout and User-Agent
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const options = { 
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DockerMetrics/1.0' },
        timeout: 10000 
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Status ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Optimized Fetch Function
async function fetchRealData() {
  const allImages = [];
  console.log(`\n[${new Date().toLocaleTimeString()}] 🔍 Scanning Docker Hub...`);
  
  for (const namespace of NAMESPACES) {
    try {
      // Get all repositories (pull_count is included in this list response)
      const url = `https://hub.docker.com/v2/repositories/${namespace}/?page_size=100`;
      const data = await fetchJSON(url);
      const repos = data.results || [];
      
      for (const repo of repos) {
        const fullName = `${namespace}/${repo.name}`;
        const currentPulls = repo.pull_count || 0;

        // --- DETECT GROWTH (DELTA) ---
        if (pullCountHistory.has(fullName)) {
          const previousPulls = pullCountHistory.get(fullName);
          
          if (currentPulls > previousPulls) {
            const diff = currentPulls - previousPulls;
            console.log(`📈 GROWTH DETECTED: ${fullName} (+${diff})`);
            
            // Log the change
            recentChangesLog.unshift({
              name: repo.name,
              namespace: namespace,
              diff: diff,
              timestamp: new Date()
            });

            // Keep log limited to 20 entries
            if (recentChangesLog.length > 20) recentChangesLog.pop();
          }
        }

        // Store current count for the next comparison
        pullCountHistory.set(fullName, currentPulls);

        allImages.push({
          name: repo.name,
          namespace: namespace,
          fullName: fullName,
          pullCount: currentPulls,
          lastUpdated: repo.last_updated
        });
      }
    } catch (error) {
      console.log(`  ⚠️ Skipping ${namespace}: ${error.message}`);
    }
    // Polite delay
    await new Promise(r => setTimeout(r, 100));
  }
  
  allImages.sort((a, b) => b.pullCount - a.pullCount);
  
  const namespaceStats = {};
  allImages.forEach(img => {
    if (!namespaceStats[img.namespace]) {
      namespaceStats[img.namespace] = { imageCount: 0, totalPulls: 0 };
    }
    namespaceStats[img.namespace].imageCount++;
    namespaceStats[img.namespace].totalPulls += img.pullCount;
  });
  
  const totalPulls = allImages.reduce((sum, img) => sum + img.pullCount, 0);
  
  return {
    images: allImages,
    totalPulls: totalPulls,
    totalImages: allImages.length,
    namespaceStats: namespaceStats,
    lastUpdate: new Date(),
    isReady: true
  };
}

async function updateData() {
  if (isUpdating) return;
  isUpdating = true;
  try {
    const data = await fetchRealData();
    cachedData = data;
    console.log(`✅ Update Successful: ${cachedData.totalPulls.toLocaleString()} total pulls`);
  } catch (error) {
    console.error(`❌ Global Update Error:`, error);
  } finally {
    isUpdating = false;
  }
}

// API endpoint
app.get('/api/metrics', (req, res) => {
  res.json({
    success: true,
    data: {
      ...cachedData,
      recentChanges: recentChangesLog 
    }
  });
});

// Serve the UI
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
            padding: 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
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
            box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
            transition: transform 0.2s;
        }
        .stat-card:hover { transform: translateY(-4px); }
        .stat-icon {
            width: 48px; height: 48px;
            border-radius: 16px;
            display: flex; align-items: center; justify-content: center;
            font-size: 24px; margin-bottom: 16px;
        }
        .stat-icon.blue { background: rgba(59, 130, 246, 0.1); color: #3b82f6; }
        .stat-icon.purple { background: rgba(139, 92, 246, 0.1); color: #8b5cf6; }
        .stat-icon.green { background: rgba(16, 185, 129, 0.1); color: #10b981; }
        .stat-value { font-size: 2rem; font-weight: 700; margin-bottom: 8px; }
        .stat-label { color: #718096; font-size: 0.875rem; font-weight: 500; }
        .section-title {
            font-size: 1.5rem; font-weight: 600;
            margin-bottom: 24px; display: flex; align-items: center; gap: 12px; color: white;
        }
        .table-container {
            background: white; border-radius: 20px; overflow: hidden;
            margin-bottom: 32px; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
        }
        table { width: 100%; border-collapse: collapse; }
        thead { background: #f8fafc; color: #4a5568; }
        th, td { padding: 16px 20px; text-align: left; }
        td { border-bottom: 1px solid #e2e8f0; }
        .badge {
            display: inline-flex; padding: 4px 12px;
            border-radius: 12px; font-size: 0.75rem; font-weight: 600;
            background: rgba(102, 126, 234, 0.1); color: #667eea;
        }
        .trend-up { color: #10b981; font-weight: 600; }
        .live-indicator {
            width: 8px; height: 8px; background: #10b981;
            border-radius: 50%; display: inline-block;
            animation: pulse 2s infinite; margin-right: 8px;
        }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
        .loading-text { padding: 40px; text-align: center; color: #718096; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><i class="fab fa-docker"></i> Docker Metrics Dashboard</h1>
            <div class="header-subtitle">
                Monitoring ${NAMESPACES.length} namespaces | Real-time pull statistics
                <span style="margin-left:15px">🟢 Live</span>
            </div>
        </div>

        <div class="stats-grid" id="statsGrid">
            <!-- Loading placeholders -->
        </div>

        <div class="section-title">
            <i class="fas fa-chart-line"></i>
            <span>Recent Growth</span>
            <span class="live-indicator"></span>
            <span id="updateTimer" style="font-size:0.8rem; font-weight:400">Syncing...</span>
        </div>

        <div class="table-container">
            <table>
                <thead><tr><th>Image</th><th>Namespace</th><th>Increase</th><th>Time Detected</th></tr></thead>
                <tbody id="changesBody">
                    <tr><td colspan="4" class="loading-text">Detecting changes in next scan...</td></tr>
                </tbody>
            </table>
        </div>

        <div class="section-title">
            <i class="fas fa-ranking-star"></i>
            <span>Top Repositories by Pulls</span>
        </div>

        <div class="table-container">
            <table>
                <thead><tr><th>Rank</th><th>Repository Name</th><th>Namespace</th><th>Total Pulls</th></tr></thead>
                <tbody id="imagesBody">
                    <tr><td colspan="4" class="loading-text">Loading repository data...</td></tr>
                </tbody>
            </table>
        </div>
    </div>

    <script>
        async function refreshData() {
            try {
                const res = await fetch('/api/metrics');
                const json = await res.json();
                const d = json.data;

                // Update Stats
                document.getElementById('statsGrid').innerHTML = \`
                    <div class="stat-card">
                        <div class="stat-icon blue"><i class="fas fa-images"></i></div>
                        <div class="stat-value">\${d.totalImages}</div>
                        <div class="stat-label">Total Images</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon purple"><i class="fas fa-download"></i></div>
                        <div class="stat-value">\${d.totalPulls.toLocaleString()}</div>
                        <div class="stat-label">Total Pulls</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon green"><i class="fas fa-cube"></i></div>
                        <div class="stat-value">\${Object.keys(d.namespaceStats).length}</div>
                        <div class="stat-label">Namespaces</div>
                    </div>
                \`;

                // Update Growth Table
                const cBody = document.getElementById('changesBody');
                if (d.recentChanges.length === 0) {
                    cBody.innerHTML = '<tr><td colspan="4" class="loading-text">Waiting for the first increase...</td></tr>';
                } else {
                    cBody.innerHTML = d.recentChanges.map(c => \`
                        <tr>
                            <td><strong>\${c.name}</strong></td>
                            <td><span class="badge">\${c.namespace}</span></td>
                            <td class="trend-up">+\${c.diff.toLocaleString()} pulls</td>
                            <td>\${new Date(c.timestamp).toLocaleTimeString()}</td>
                        </tr>
                    \`).join('');
                }

                // Update Top Images
                document.getElementById('imagesBody').innerHTML = d.images.slice(0, 50).map((img, i) => \`
                    <tr>
                        <td>\${i + 1}</td>
                        <td><strong>\${img.name}</strong></td>
                        <td><span class="badge">\${img.namespace}</span></td>
                        <td><strong>\${img.pullCount.toLocaleString()}</strong></td>
                    </tr>
                \`).join('');

                document.getElementById('updateTimer').innerText = 'Last updated: ' + new Date(d.lastUpdate).toLocaleTimeString();

            } catch (e) { console.error("Refresh Error:", e); }
        }

        // Auto-refresh UI every 3 seconds
        setInterval(refreshData, 3000);
        refreshData();
    </script>
</body>
</html>`);
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✨ Dashboard Live: http://localhost:${PORT}`);
  updateData(); // Initial run
  setInterval(updateData, 60000); // Background scan every 60 seconds
});
