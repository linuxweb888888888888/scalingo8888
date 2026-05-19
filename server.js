const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const NAMESPACES = [
  'phemextradebot', 'linux84744474', 'linux88884474', 'webapps84', 
  'tradingbotapp', 'webcoder4', 'weblinux84', 'tradepackage', 
  'hitbtctradebot', 'webwebwebwebwebweb', 'webpackage', 'clevertradebot', 
  'linux88888888', 'linuxlinuxlinuxlinux8888', 'tradeincbot', 
  'tradeincbotbot', 'buyrunplace'
];

// --- PERSISTENT DATA BEYOND REFRESHES ---
let pullCountHistory = new Map(); // Global memory of counts
let recentChangesLog = [];       // Global log of changes

let cachedData = {
  images: [],
  totalPulls: 0,
  totalImages: 0,
  namespaceStats: {},
  lastUpdate: new Date(),
  isReady: false
};

let isUpdating = false;

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const options = { 
        headers: { 'User-Agent': 'Mozilla/5.0' },
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

async function fetchRealData() {
  const allImages = [];
  console.log(`\n[${new Date().toLocaleTimeString()}] 🔍 Scanning Docker Hub...`);
  
  for (const namespace of NAMESPACES) {
    try {
      const url = `https://hub.docker.com/v2/repositories/${namespace}/?page_size=100`;
      const data = await fetchJSON(url);
      const repos = data.results || [];
      
      for (const repo of repos) {
        const fullName = `${namespace}/${repo.name}`;
        const currentPulls = repo.pull_count || 0;

        // --- DETECT GROWTH ---
        if (pullCountHistory.has(fullName)) {
          const previousPulls = pullCountHistory.get(fullName);
          
          if (currentPulls > previousPulls) {
            const diff = currentPulls - previousPulls;
            console.log(`📈 GROWTH DETECTED: ${fullName} (+${diff})`);
            
            // Add to the start of the global log
            recentChangesLog.unshift({
              name: repo.name,
              namespace: namespace,
              diff: diff,
              timestamp: new Date()
            });

            // Keep log size manageable
            if (recentChangesLog.length > 50) recentChangesLog.pop();
          }
        }

        // Update History
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
      console.log(`  ⚠️ Failed ${namespace}: ${error.message}`);
    }
    await new Promise(r => setTimeout(r, 100)); // Be nice to API
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
    console.log(`✅ Update Successful. Total Pulls: ${cachedData.totalPulls.toLocaleString()}`);
  } catch (error) {
    console.error(`❌ Global Update Error:`, error);
  } finally {
    isUpdating = false;
  }
}

// API endpoint merges stats with the global changes log
app.get('/api/metrics', (req, res) => {
  res.json({
    success: true,
    data: {
      ...cachedData,
      recentChanges: recentChangesLog // Include the global log
    }
  });
});

app.get('/', (req, res) => {
  res.send(htmlTemplate());
});

function htmlTemplate() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Docker Hub Metrics</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        body { font-family: 'Inter', sans-serif; background: #0f172a; color: white; padding: 20px; }
        .container { max-width: 1100px; margin: 0 auto; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .card { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; }
        .val { font-size: 1.5rem; font-weight: bold; color: #38bdf8; }
        .lbl { font-size: 0.8rem; color: #94a3b8; }
        table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; margin-bottom: 30px; }
        th { text-align: left; padding: 15px; background: #334155; font-size: 0.9rem; }
        td { padding: 15px; border-top: 1px solid #334155; font-size: 0.9rem; }
        .growth { color: #4ade80; font-weight: bold; }
        .badge { background: #0ea5e9; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; }
        h2 { margin-bottom: 15px; font-size: 1.2rem; display: flex; align-items: center; gap: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <h2><i class="fab fa-docker"></i> Docker Hub Real-Time Metrics</h2>
        
        <div class="grid" id="statsGrid"></div>

        <h2><i class="fas fa-chart-line"></i> Recent Growth (New Pulls)</h2>
        <table>
            <thead><tr><th>Image</th><th>Namespace</th><th>Increase</th><th>Time Detected</th></tr></thead>
            <tbody id="changesBody"></tbody>
        </table>

        <h2><i class="fas fa-trophy"></i> Top 50 Repositories</h2>
        <table>
            <thead><tr><th>Rank</th><th>Repository</th><th>Namespace</th><th>Total Pulls</th></tr></thead>
            <tbody id="imagesBody"></tbody>
        </table>
    </div>

    <script>
        async function refresh() {
            try {
                const r = await fetch('/api/metrics');
                const j = await r.json();
                const d = j.data;

                document.getElementById('statsGrid').innerHTML = \`
                    <div class="card"><div class="val">\${d.totalPulls.toLocaleString()}</div><div class="lbl">Total Pulls</div></div>
                    <div class="card"><div class="val">\${d.totalImages}</div><div class="lbl">Total Images</div></div>
                    <div class="card"><div class="val">\${Object.keys(d.namespaceStats).length}</div><div class="lbl">Namespaces</div></div>
                \`;

                const cBody = document.getElementById('changesBody');
                if (d.recentChanges.length === 0) {
                    cBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#64748b">No new growth detected in the last scan...</td></tr>';
                } else {
                    cBody.innerHTML = d.recentChanges.map(c => \`
                        <tr>
                            <td><strong>\${c.name}</strong></td>
                            <td><span class="badge">\${c.namespace}</span></td>
                            <td class="growth">+\${c.diff.toLocaleString()}</td>
                            <td>\${new Date(c.timestamp).toLocaleTimeString()}</td>
                        </tr>
                    \`).join('');
                }

                document.getElementById('imagesBody').innerHTML = d.images.slice(0, 50).map((img, i) => \`
                    <tr>
                        <td>#\${i+1}</td>
                        <td><strong>\${img.name}</strong></td>
                        <td><span class="badge">\${img.namespace}</span></td>
                        <td>\${img.pullCount.toLocaleString()}</td>
                    </tr>
                \`).join('');
            } catch(e) {}
        }
        setInterval(refresh, 3000);
        refresh();
    </script>
</body>
</html>`;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server on http://localhost:${PORT}`);
  updateData(); // First run
  setInterval(updateData, 60000); // Check every 60 seconds
});
