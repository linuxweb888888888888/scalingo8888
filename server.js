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

// Memory storage for tracking changes (deltas)
let pullCountHistory = new Map(); 

let cachedData = {
  images: [],
  totalPulls: 0,
  totalImages: 0,
  namespaceStats: {},
  recentChanges: [],
  lastUpdate: new Date(),
  isReady: false
};

let isUpdating = false;

// Fetch helper with timeout
function fetchJSON(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
    const options = { headers: { 'User-Agent': 'Docker-Metrics-Bot/1.0' } };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Optimized Fetch Function
async function fetchRealData() {
  const allImages = [];
  const currentChanges = [...cachedData.recentChanges];
  
  console.log(`\n🔍 Scanning ${NAMESPACES.length} namespaces...`);
  
  for (const namespace of NAMESPACES) {
    try {
      // Fetching 100 repos at once. pull_count is included in this response!
      const url = `https://hub.docker.com/v2/repositories/${namespace}/?page_size=100`;
      const data = await fetchJSON(url, 8000);
      const repos = data.results || [];
      
      console.log(`  ✅ ${namespace}: ${repos.length} repos`);

      for (const repo of repos) {
        const fullName = `${namespace}/${repo.name}`;
        const pullCount = repo.pull_count || 0;

        // Check for changes since last scan
        if (pullCountHistory.has(fullName)) {
            const previous = pullCountHistory.get(fullName);
            if (pullCount > previous) {
                currentChanges.unshift({
                    name: repo.name,
                    namespace: namespace,
                    diff: pullCount - previous,
                    timestamp: new Date()
                });
            }
        }
        pullCountHistory.set(fullName, pullCount);

        allImages.push({
          name: repo.name,
          namespace: namespace,
          fullName: fullName,
          pullCount: pullCount,
          lastUpdated: repo.last_updated
        });
      }
    } catch (error) {
      console.log(`  ⚠️ Skipping ${namespace}: ${error.message}`);
    }
    // Small delay to be polite to Docker API
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
    recentChanges: currentChanges.slice(0, 20), // Keep last 20 changes
    lastUpdate: new Date(),
    isReady: true
  };
}

async function updateData() {
  if (isUpdating) return;
  isUpdating = true;
  try {
    const realData = await fetchRealData();
    cachedData = realData;
    console.log(`✅ Update Successful: ${cachedData.totalPulls.toLocaleString()} total pulls`);
  } catch (error) {
    console.error(`❌ Update Failed:`, error.message);
  } finally {
    isUpdating = false;
  }
}

app.use(express.json());

app.get('/api/metrics', (req, res) => {
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    data: cachedData
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', lastUpdate: cachedData.lastUpdate });
});

app.get('/', (req, res) => {
  // Sending the HTML content
  res.send(getHTMLContent());
});

// Helper for the large HTML block
function getHTMLContent() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Docker Hub Metrics Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; color: #1a202c; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { background: white; border-radius: 20px; padding: 25px; margin-bottom: 25px; box-shadow: 0 10px 15px rgba(0,0,0,0.1); }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: white; border-radius: 15px; padding: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        .stat-value { font-size: 1.8rem; font-weight: 700; color: #2d3748; }
        .stat-label { color: #718096; font-size: 0.9rem; }
        .table-container { background: white; border-radius: 15px; overflow: hidden; margin-bottom: 30px; }
        table { width: 100%; border-collapse: collapse; }
        th { background: #f7fafc; padding: 15px; text-align: left; color: #4a5568; }
        td { padding: 15px; border-top: 1px solid #edf2f7; }
        .badge { background: #ebf4ff; color: #3182ce; padding: 4px 8px; border-radius: 6px; font-size: 0.8rem; font-weight: 600; }
        .trend-up { color: #38a169; font-weight: bold; }
        .section-title { color: white; margin-bottom: 15px; display: flex; align-items: center; gap: 10px; font-size: 1.2rem; }
        .loading { padding: 40px; text-align: center; color: #718096; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="color: #4a5568"><i class="fab fa-docker"></i> Docker Metrics Dashboard</h1>
            <p id="status">Status: 🟢 Connected</p>
        </div>

        <div class="stats-grid" id="statsGrid"></div>

        <div class="section-title"><i class="fas fa-bolt"></i> Recent Growth</div>
        <div class="table-container">
            <table>
                <thead><tr><th>Image</th><th>Namespace</th><th>Growth</th><th>Time</th></tr></thead>
                <tbody id="changesBody"></tbody>
            </table>
        </div>

        <div class="section-title"><i class="fas fa-list"></i> Top Repositories</div>
        <div class="table-container">
            <table>
                <thead><tr><th>Rank</th><th>Repository</th><th>Namespace</th><th>Pulls</th></tr></thead>
                <tbody id="imagesBody"></tbody>
            </table>
        </div>
    </div>

    <script>
        async function update() {
            try {
                const res = await fetch('/api/metrics');
                const json = await res.json();
                const data = json.data;

                // Update Stats
                document.getElementById('statsGrid').innerHTML = \`
                    <div class="stat-card"><div class="stat-value">\${data.totalImages}</div><div class="stat-label">Total Images</div></div>
                    <div class="stat-card"><div class="stat-value">\${data.totalPulls.toLocaleString()}</div><div class="stat-label">Total Pulls</div></div>
                    <div class="stat-card"><div class="stat-value">\${Object.keys(data.namespaceStats).length}</div><div class="stat-label">Namespaces</div></div>
                \`;

                // Update Changes
                const changesBody = document.getElementById('changesBody');
                if(data.recentChanges.length === 0) {
                    changesBody.innerHTML = '<tr><td colspan="4" style="text-align:center">Waiting for growth detection...</td></tr>';
                } else {
                    changesBody.innerHTML = data.recentChanges.map(c => \`
                        <tr>
                            <td><strong>\${c.name}</strong></td>
                            <td><span class="badge">\${c.namespace}</span></td>
                            <td class="trend-up">+\${c.diff}</td>
                            <td>\${new Date(c.timestamp).toLocaleTimeString()}</td>
                        </tr>
                    \`).join('');
                }

                // Update Images
                document.getElementById('imagesBody').innerHTML = data.images.slice(0, 50).map((img, i) => \`
                    <tr>
                        <td>#\${i+1}</td>
                        <td><strong>\${img.name}</strong></td>
                        <td><span class="badge">\${img.namespace}</span></td>
                        <td>\${img.pullCount.toLocaleString()}</td>
                    </tr>
                \`).join('');

            } catch(e) { console.error(e); }
        }
        setInterval(update, 3000);
        update();
    </script>
</body>
</html>`;
}

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✨ Dashboard running at http://localhost:${PORT}`);
  
  // Initial data fetch
  updateData();
  
  // Update every 2 minutes (Docker Hub caches results, so 1 min is plenty)
  setInterval(updateData, 120000); 
});
