// ============ DASHBOARD (MATERIAL DESIGN) ============
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bot Controller | Material Design</title>
    <!-- Material Icons & Fonts -->
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
    <style>
        :root {
            --primary: #6200ee;
            --primary-variant: #3700b3;
            --secondary: #03dac6;
            --background: #f4f7f9;
            --surface: #ffffff;
            --error: #b00020;
            --on-surface: #000000;
            --text-secondary: #757575;
            --shadow: 0px 3px 5px -1px rgba(0,0,0,0.2), 0px 6px 10px 0px rgba(0,0,0,0.14), 0px 1px 18px 0px rgba(0,0,0,0.12);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Roboto', sans-serif; 
            background-color: var(--background); 
            color: var(--on-surface);
            line-height: 1.5;
        }

        /* Top App Bar */
        header {
            background: var(--primary);
            color: white;
            padding: 16px 24px;
            box-shadow: var(--shadow);
            display: flex;
            align-items: center;
            position: sticky;
            top: 0;
            z-index: 100;
        }
        header i { margin-right: 16px; }
        header h1 { font-size: 20px; font-weight: 500; }

        .container { max-width: 1100px; margin: 32px auto; padding: 0 24px; }

        /* Stats Cards */
        .metrics-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); 
            gap: 24px; 
            margin-bottom: 32px; 
        }

        .metric-card { 
            background: var(--surface); 
            border-radius: 8px; 
            padding: 24px; 
            box-shadow: var(--shadow);
            transition: transform 0.2s;
        }
        .metric-card:hover { transform: translateY(-4px); }
        .metric-label { font-size: 14px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 1px; font-weight: 500; }
        .metric-value { font-size: 36px; font-weight: 700; color: var(--primary); margin-top: 8px; }

        /* Status Badge */
        .badge {
            display: inline-flex;
            align-items: center;
            padding: 6px 12px;
            border-radius: 16px;
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
        }
        .status-running { background: #e8f5e9; color: #2e7d32; }
        .status-starting { background: #fff3e0; color: #ef6c00; }
        .status-completed { background: #e3f2fd; color: #1565c0; }
        .pulse {
            width: 8px; height: 8px; background: currentColor;
            border-radius: 50%; margin-right: 8px;
            animation: pulse-animation 1.5s infinite;
        }
        @keyframes pulse-animation { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }

        /* Table Design */
        .main-card { 
            background: var(--surface); 
            border-radius: 8px; 
            box-shadow: var(--shadow); 
            overflow: hidden;
            margin-bottom: 32px;
        }
        .card-header { padding: 20px 24px; border-bottom: 1px solid #eee; display: flex; align-items: center; justify-content: space-between; }
        .card-title { font-size: 18px; font-weight: 500; }

        .table-container { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        th { 
            background: #f8f9fa; 
            text-align: left; 
            padding: 16px 24px; 
            font-size: 13px; 
            color: var(--text-secondary); 
            border-bottom: 1px solid #eee;
        }
        td { padding: 16px 24px; border-bottom: 1px solid #eee; font-size: 14px; }
        tr:hover { background-color: #fafafa; }

        .info-panel {
            background: #fff;
            border-left: 4px solid var(--secondary);
            padding: 16px 24px;
            border-radius: 4px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .info-panel p { color: var(--text-secondary); font-size: 14px; margin: 4px 0; }
    </style>
</head>
<body>
    <header>
        <i class="material-icons">smart_toy</i>
        <h1>Clever Cloud Automation Engine</h1>
    </header>

    <div class="container">
        <div class="metrics-grid">
            <div class="metric-card">
                <div class="metric-label">Total Created</div>
                <div class="metric-value" id="totalAccounts">0</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Sessions Today</div>
                <div class="metric-value" id="todayAccounts">0</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">IP Rotations</div>
                <div class="metric-value" id="restartCount">0</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">System State</div>
                <div id="botStateContainer" style="margin-top:12px;">
                    <span class="badge status-starting" id="botStateBadge">
                        <div class="pulse"></div><span id="botStateText">Initializing</span>
                    </span>
                </div>
            </div>
        </div>

        <div class="main-card">
            <div class="card-header">
                <div class="card-title">Database Records</div>
                <i class="material-icons" style="color: var(--text-secondary)">storage</i>
            </div>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>EMAIL ADDRESS</th>
                            <th>SECURE PASSWORD</th>
                            <th>TIMESTAMP</th>
                        </tr>
                    </thead>
                    <tbody id="accountsBody">
                        <tr><td colspan="3" style="text-align:center; color: #999;">Querying MongoDB...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div class="info-panel">
            <p><strong>Deployment Mode:</strong> Single-Account Rotation Policy</p>
            <p><strong>Method:</strong> Puppeteer Stealth + Scalingo CLI IP-Refresh</p>
        </div>
    </div>

    <script>
        async function refreshData() {
            try {
                const res = await fetch('/api/metrics');
                const data = await res.json();
                
                document.getElementById('totalAccounts').textContent = data.totalAccounts || 0;
                document.getElementById('todayAccounts').textContent = data.completedToday || 0;
                document.getElementById('restartCount').textContent = data.restartCount || 0;
                
                // Update Badge
                const state = data.botState || 'starting';
                const badge = document.getElementById('botStateBadge');
                const text = document.getElementById('botStateText');
                
                badge.className = 'badge status-' + state;
                text.textContent = state.toUpperCase();
                
                // Update Table
                const accountsRes = await fetch('/api/accounts');
                const accounts = await accountsRes.json();
                const tbody = document.getElementById('accountsBody');
                
                if (accounts && accounts.length) {
                    tbody.innerHTML = accounts.map(acc => \`
                        <tr>
                            <td style="font-weight:500; color:var(--primary)">\${acc.email}</td>
                            <td style="font-family:monospace; color: #444;">\${acc.password}</td>
                            <td style="color: var(--text-secondary)">\${new Date(acc.createdAt).toLocaleString()}</td>
                        </tr>
                    \`).join('');
                }
            } catch(e) { console.error('Dashboard Error:', e); }
        }

        refreshData();
        setInterval(refreshData, 5000);
    </script>
</body>
</html>`);
});
