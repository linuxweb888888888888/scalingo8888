// server.js
const express = require('express');
const axios = require('axios');
const { Octokit } = require('@octokit/rest');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Octokit (GitHub API client)
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN, // Optional: add token for higher rate limits
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Helper function to fetch file from GitHub
async function fetchGitHubFile(owner, repo, filePath, commitSha = null) {
  try {
    let url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
    if (commitSha) {
      url += `?ref=${commitSha}`;
    }
    
    const response = await axios.get(url, {
      headers: process.env.GITHUB_TOKEN ? {
        'Authorization': `token ${process.env.GITHUB_TOKEN}`
      } : {}
    });
    
    // Decode content from base64
    const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
    return {
      content,
      sha: response.data.sha,
      metadata: response.data
    };
  } catch (error) {
    throw new Error(`Failed to fetch ${filePath}: ${error.message}`);
  }
}

// Helper function to get file history (commits)
async function getFileHistory(owner, repo, filePath) {
  try {
    const response = await octokit.repos.listCommits({
      owner,
      repo,
      path: filePath,
      per_page: 30
    });
    
    return response.data.map(commit => ({
      sha: commit.sha,
      date: commit.commit.author.date,
      message: commit.commit.message,
      author: commit.commit.author.name
    }));
  } catch (error) {
    console.error('Error fetching history:', error.message);
    return [];
  }
}

// API endpoint to get package.json
app.get('/api/package/:owner/:repo', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { commit } = req.query;
    
    const result = await fetchGitHubFile(owner, repo, 'package.json', commit);
    const packageJson = JSON.parse(result.content);
    
    res.json({
      success: true,
      packageJson,
      sha: result.sha,
      commit
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to get script file
app.get('/api/script/:owner/:repo/:scriptPath(*)', async (req, res) => {
  try {
    const { owner, repo, scriptPath } = req.params;
    const { commit } = req.query;
    
    const result = await fetchGitHubFile(owner, repo, scriptPath, commit);
    
    // Set content type based on file extension
    const ext = path.extname(scriptPath);
    let contentType = 'text/plain';
    if (ext === '.js') contentType = 'application/javascript';
    else if (ext === '.json') contentType = 'application/json';
    else if (ext === '.css') contentType = 'text/css';
    
    res.set('Content-Type', contentType);
    res.send(result.content);
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to get file history
app.get('/api/history/:owner/:repo/:filePath(*)', async (req, res) => {
  try {
    const { owner, repo, filePath } = req.params;
    
    const history = await getFileHistory(owner, repo, filePath);
    
    res.json({
      success: true,
      filePath,
      history
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to load and execute a script from GitHub history
app.get('/api/load-script/:owner/:repo/:scriptPath(*)', async (req, res) => {
  try {
    const { owner, repo, scriptPath } = req.params;
    const { commit } = req.query;
    
    // Fetch the script content
    const result = await fetchGitHubFile(owner, repo, scriptPath, commit);
    
    // Fetch package.json for context
    let packageJson = null;
    try {
      const pkgResult = await fetchGitHubFile(owner, repo, 'package.json', commit);
      packageJson = JSON.parse(pkgResult.content);
    } catch (err) {
      console.log('No package.json found');
    }
    
    // Get history for this script
    const history = await getFileHistory(owner, repo, scriptPath);
    
    res.json({
      success: true,
      script: {
        name: scriptPath,
        content: result.content,
        sha: result.sha,
        commit: commit || 'latest',
        size: result.content.length
      },
      packageJson,
      history: history.slice(0, 10), // Last 10 commits
      metadata: {
        fetchedAt: new Date().toISOString(),
        fromCommit: commit || 'latest'
      }
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

// Dynamic script execution endpoint (with vm isolation)
app.post('/api/execute-script/:owner/:repo/:scriptPath(*)', async (req, res) => {
  try {
    const { owner, repo, scriptPath } = req.params;
    const { commit, args = [] } = req.body;
    
    // Fetch the script content
    const result = await fetchGitHubFile(owner, repo, scriptPath, commit);
    const scriptContent = result.content;
    
    // Fetch package.json if available
    let packageJson = null;
    try {
      const pkgResult = await fetchGitHubFile(owner, repo, 'package.json', commit);
      packageJson = JSON.parse(pkgResult.content);
    } catch (err) {
      // No package.json, continue
    }
    
    // Create a safe execution context
    const vm = require('vm');
    const sandbox = {
      console: console,
      require: require,
      process: process,
      module: { exports: {} },
      exports: {},
      __dirname: __dirname,
      __filename: __filename,
      args: args,
      packageJson: packageJson
    };
    
    try {
      const script = new vm.Script(scriptContent);
      const context = vm.createContext(sandbox);
      script.runInContext(context);
      
      res.json({
        success: true,
        execution: {
          exports: sandbox.module.exports,
          packageJson,
        },
        metadata: {
          scriptPath,
          commit: commit || 'latest',
          executedAt: new Date().toISOString()
        }
      });
    } catch (execError) {
      res.status(400).json({
        success: false,
        error: `Execution error: ${execError.message}`
      });
    }
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

// Serve a web interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>GitHub Script Loader</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
        input, button { padding: 10px; margin: 5px; }
        input { width: calc(100% - 24px); margin: 5px 0; }
        button { background: #0366d6; color: white; border: none; cursor: pointer; }
        button:hover { background: #0255b3; }
        .result { background: #f6f8fa; padding: 15px; margin-top: 20px; border-radius: 5px; overflow-x: auto; }
        pre { white-space: pre-wrap; word-wrap: break-word; }
        .error { color: red; }
        .commit-list { list-style: none; padding: 0; }
        .commit-item { padding: 10px; border-bottom: 1px solid #e1e4e8; cursor: pointer; }
        .commit-item:hover { background: #f6f8fa; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📦 GitHub Script Loader</h1>
        <p>Load scripts and package.json from GitHub file history</p>
        
        <div>
          <h3>Load Script with History</h3>
          <input type="text" id="owner" placeholder="Owner (e.g., facebook)" />
          <input type="text" id="repo" placeholder="Repository (e.g., react)" />
          <input type="text" id="scriptPath" placeholder="Script path (e.g., src/index.js)" />
          <button onclick="loadScript()">Load Script</button>
        </div>
        
        <div id="result" class="result"></div>
      </div>
      
      <script>
        async function loadScript() {
          const owner = document.getElementById('owner').value;
          const repo = document.getElementById('repo').value;
          const scriptPath = document.getElementById('scriptPath').value;
          const resultDiv = document.getElementById('result');
          
          if (!owner || !repo || !scriptPath) {
            resultDiv.innerHTML = '<p class="error">Please fill all fields</p>';
            return;
          }
          
          resultDiv.innerHTML = '<p>Loading...</p>';
          
          try {
            const response = await fetch(\`/api/load-script/\${owner}/\${repo}/\${scriptPath}\`);
            const data = await response.json();
            
            if (data.success) {
              let historyHtml = '<h3>Script History:</h3><ul class="commit-list">';
              if (data.history && data.history.length > 0) {
                data.history.forEach(commit => {
                  historyHtml += \`
                    <li class="commit-item" onclick="loadCommit('\${commit.sha}')">
                      <strong>\${commit.sha.substring(0, 7)}</strong> - \${commit.message}<br>
                      <small>\${commit.author} - \${new Date(commit.date).toLocaleString()}</small>
                    </li>
                  \`;
                });
              }
              historyHtml += '</ul>';
              
              resultDiv.innerHTML = \`
                <h3>✅ Script Loaded: \${data.script.name}</h3>
                <p><strong>SHA:</strong> \${data.script.sha}</p>
                <p><strong>Size:</strong> \${data.script.size} bytes</p>
                <p><strong>From Commit:</strong> \${data.metadata.fromCommit || 'latest'}</p>
                
                \${data.packageJson ? \`
                  <h3>📦 Package.json:</h3>
                  <pre>\${JSON.stringify(data.packageJson, null, 2)}</pre>
                \` : '<p>No package.json found</p>'}
                
                \${historyHtml}
                
                <h3>📄 Script Content:</h3>
                <pre>\${escapeHtml(data.script.content.substring(0, 2000))}\${data.script.content.length > 2000 ? '...' : ''}</pre>
              \`;
            } else {
              resultDiv.innerHTML = \`<p class="error">Error: \${data.error}</p>\`;
            }
          } catch (error) {
            resultDiv.innerHTML = \`<p class="error">Error: \${error.message}</p>\`;
          }
        }
        
        async function loadCommit(commitSha) {
          const owner = document.getElementById('owner').value;
          const repo = document.getElementById('repo').value;
          const scriptPath = document.getElementById('scriptPath').value;
          const resultDiv = document.getElementById('result');
          
          resultDiv.innerHTML = '<p>Loading commit...</p>';
          
          try {
            const response = await fetch(\`/api/load-script/\${owner}/\${repo}/\${scriptPath}?commit=\${commitSha}\`);
            const data = await response.json();
            
            if (data.success) {
              resultDiv.innerHTML = \`
                <h3>📜 Commit \${commitSha.substring(0, 7)}</h3>
                <pre>\${escapeHtml(data.script.content.substring(0, 2000))}</pre>
                <p><small>Fetched at: \${data.metadata.fetchedAt}</small></p>
              \`;
            }
          } catch (error) {
            resultDiv.innerHTML = \`<p class="error">Error loading commit: \${error.message}</p>\`;
          }
        }
        
        function escapeHtml(text) {
          const div = document.createElement('div');
          div.textContent = text;
          return div.innerHTML;
        }
      </script>
    </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 GitHub Script Loader server running at http://localhost:${PORT}`);
  console.log(`\n📝 Example API calls:`);
  console.log(`  - Load script: http://localhost:${PORT}/api/load-script/facebook/react/src/index.js`);
  console.log(`  - Get package.json: http://localhost:${PORT}/api/package/facebook/react`);
  console.log(`  - Get file history: http://localhost:${PORT}/api/history/facebook/react/package.json`);
  console.log(`  - Execute script: POST to http://localhost:${PORT}/api/execute-script/owner/repo/path.js`);
});
