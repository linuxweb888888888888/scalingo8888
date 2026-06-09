// server.js - Fixed version with proper token authentication
const express = require('express');
const axios = require('axios');
const { Octokit } = require('@octokit/rest');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const app = express();
const PORT = process.env.PORT || 3000;

// Load .env file
try {
  if (fs.existsSync('.env')) {
    require('dotenv').config();
    console.log('✅ Loaded .env file');
  }
} catch (err) {
  console.log('No .env file found');
}

// IMPORTANT: Get token from environment
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;

// Test token validity immediately
async function testTokenValidity() {
  if (!GITHUB_TOKEN) {
    console.log('⚠️  No GitHub token provided');
    return false;
  }
  
  try {
    // Test with both authentication methods
    const testUrl = 'https://api.github.com/rate_limit';
    
    // Method 1: Using 'token' prefix (classic way)
    const response1 = await axios.get(testUrl, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'GitHub-Script-Loader',
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    if (response1.status === 200) {
      console.log('✅ GitHub token is VALID (using token prefix)');
      console.log(`   Rate limit: ${response1.data.rate.remaining}/${response1.data.rate.limit} requests remaining`);
      return true;
    }
  } catch (error) {
    console.log('❌ Token test failed:', error.response?.data?.message || error.message);
    
    // Try alternative authentication method
    try {
      const response2 = await axios.get(testUrl, {
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'User-Agent': 'GitHub-Script-Loader',
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      
      if (response2.status === 200) {
        console.log('✅ GitHub token is VALID (using Bearer prefix)');
        return true;
      }
    } catch (error2) {
      console.log('❌ Token also failed with Bearer prefix');
    }
    
    console.log('\n🔧 TOKEN ISSUES DETECTED:');
    console.log('   1. Token may be expired or revoked');
    console.log('   2. Token may not have required permissions');
    console.log('   3. Token format might be incorrect');
    console.log('\n📝 To fix:');
    console.log('   - Go to: https://github.com/settings/tokens');
    console.log('   - Generate a new classic token');
    console.log('   - Select at least "repo" and "public_repo" scopes');
    console.log('   - Copy the new token to .env file');
    return false;
  }
}

// Initialize Octokit with proper authentication
let octokit;
if (GITHUB_TOKEN) {
  // Try both authentication methods
  octokit = new Octokit({
    auth: GITHUB_TOKEN,
    userAgent: 'GitHub-Script-Loader',
    timeZone: 'UTC',
    baseUrl: 'https://api.github.com'
  });
} else {
  octokit = new Octokit({
    userAgent: 'GitHub-Script-Loader'
  });
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store data
let executionHistory = [];
let generatedPackages = [];

// ============================================
// FIXED GITHUB API CALLS
// ============================================

// Helper function to make authenticated requests
async function makeGitHubRequest(url, options = {}) {
  const headers = {
    'User-Agent': 'GitHub-Script-Loader',
    'Accept': 'application/vnd.github.v3+json',
    ...options.headers
  };
  
  // Try different authentication methods
  if (GITHUB_TOKEN) {
    // Try Bearer first (newer method)
    try {
      const response = await axios({
        method: options.method || 'GET',
        url,
        headers: {
          ...headers,
          'Authorization': `Bearer ${GITHUB_TOKEN}`
        },
        data: options.data,
        params: options.params
      });
      return response;
    } catch (bearerError) {
      // If Bearer fails, try token method
      if (bearerError.response?.status === 401) {
        const response = await axios({
          method: options.method || 'GET',
          url,
          headers: {
            ...headers,
            'Authorization': `token ${GITHUB_TOKEN}`
          },
          data: options.data,
          params: options.params
        });
        return response;
      }
      throw bearerError;
    }
  } else {
    return await axios({
      method: options.method || 'GET',
      url,
      headers,
      data: options.data,
      params: options.params
    });
  }
}

// API endpoint to test token
app.get('/api/test-token', async (req, res) => {
  try {
    const tokenValid = await testTokenValidity();
    res.json({
      hasToken: !!GITHUB_TOKEN,
      tokenValid: tokenValid,
      tokenPrefix: GITHUB_TOKEN ? GITHUB_TOKEN.substring(0, 10) + '...' : null,
      message: tokenValid ? 'Token is working correctly' : 'Token is invalid or missing'
    });
  } catch (error) {
    res.json({
      hasToken: !!GITHUB_TOKEN,
      tokenValid: false,
      error: error.message
    });
  }
});

// Get rate limit info with proper auth
app.get('/api/rate-limit', async (req, res) => {
  try {
    const response = await makeGitHubRequest('https://api.github.com/rate_limit');
    res.json({
      authenticated: !!GITHUB_TOKEN,
      rate: response.data.rate,
      token_valid: response.status === 200
    });
  } catch (error) {
    res.json({
      authenticated: false,
      error: error.response?.data?.message || error.message,
      status: error.response?.status
    });
  }
});

// Browse repository contents
app.get('/api/browse/:owner/:repo', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { path: filePath = '', branch = 'main' } = req.query;
    
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
    const response = await makeGitHubRequest(url);
    
    const contents = Array.isArray(response.data) ? response.data : [response.data];
    
    const items = contents.map(item => ({
      name: item.name,
      path: item.path,
      type: item.type,
      size: item.size,
      extension: path.extname(item.name),
      isExecutable: ['.js', '.mjs', '.cjs', '.ts', '.py', '.rb', '.sh'].includes(path.extname(item.name))
    }));
    
    // Get repo info
    const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
    const repoResponse = await makeGitHubRequest(repoUrl);
    
    res.json({
      success: true,
      owner, repo, branch,
      currentPath: filePath,
      items,
      repository: {
        name: repoResponse.data.name,
        description: repoResponse.data.description,
        stars: repoResponse.data.stargazers_count,
        forks: repoResponse.data.forks_count,
        private: repoResponse.data.private
      }
    });
  } catch (error) {
    console.error('Browse error:', error.response?.data);
    res.status(error.response?.status || 404).json({
      success: false,
      error: error.response?.data?.message || error.message,
      status: error.response?.status,
      documentation: 'https://docs.github.com/rest'
    });
  }
});

// Get file content
app.get('/api/file/:owner/:repo/:filePath(*)', async (req, res) => {
  try {
    const { owner, repo, filePath } = req.params;
    const { branch = 'main' } = req.query;
    
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
    const response = await makeGitHubRequest(url);
    
    const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
    
    // Get file history
    const historyUrl = `https://api.github.com/repos/${owner}/${repo}/commits?path=${filePath}&sha=${branch}&per_page=30`;
    const historyResponse = await makeGitHubRequest(historyUrl);
    
    const history = historyResponse.data.map(commit => ({
      sha: commit.sha,
      short_sha: commit.sha.substring(0, 7),
      message: commit.commit.message,
      date: commit.commit.author.date,
      author: commit.commit.author.name
    }));
    
    res.json({
      success: true,
      file: {
        name: path.basename(filePath),
        path: filePath,
        content: content,
        size: content.length,
        lines: content.split('\n').length,
        extension: path.extname(filePath),
        isExecutable: ['.js', '.mjs', '.cjs'].includes(path.extname(filePath))
      },
      history,
      branch
    });
  } catch (error) {
    res.status(error.response?.status || 404).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

// Generate package.json
app.post('/api/generate-package', async (req, res) => {
  try {
    const { owner, repo, scriptPath, branch = 'main' } = req.body;
    
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${scriptPath}?ref=${branch}`;
    const response = await makeGitHubRequest(url);
    const scriptContent = Buffer.from(response.data.content, 'base64').toString('utf-8');
    
    // Analyze dependencies
    const packageJson = {
      name: path.basename(scriptPath, path.extname(scriptPath)),
      version: "1.0.0",
      description: "Generated from GitHub script",
      main: scriptPath,
      scripts: {
        start: `node ${scriptPath}`,
        test: "echo \"Error: no test specified\" && exit 1"
      },
      dependencies: {},
      devDependencies: {},
      license: "ISC"
    };
    
    // Detect require/import statements
    const requireMatches = scriptContent.match(/require\(['"]([^'"]+)['"]\)/g) || [];
    const importMatches = scriptContent.match(/from ['"]([^'"]+)['"]/g) || [];
    
    const allModules = [];
    requireMatches.forEach(match => {
      const module = match.match(/require\(['"]([^'"]+)['"]\)/)[1];
      if (!module.startsWith('.') && !module.startsWith('/')) {
        allModules.push(module);
      }
    });
    
    importMatches.forEach(match => {
      const module = match.match(/from ['"]([^'"]+)['"]/)[1];
      if (!module.startsWith('.') && !module.startsWith('/')) {
        allModules.push(module);
      }
    });
    
    const uniqueModules = [...new Set(allModules)];
    uniqueModules.forEach(module => {
      if (module === 'express') packageJson.dependencies.express = "^4.18.2";
      else if (module === 'axios') packageJson.dependencies.axios = "^1.6.0";
      else if (module === 'react') packageJson.dependencies.react = "^18.2.0";
      else packageJson.dependencies[module] = "*";
    });
    
    const generatedPackage = {
      id: Date.now(),
      owner, repo, scriptPath, branch,
      packageJson,
      generatedAt: new Date().toISOString()
    };
    generatedPackages.unshift(generatedPackage);
    
    res.json({
      success: true,
      packageJson,
      installCommand: `npm install ${Object.keys(packageJson.dependencies).join(' ')}`,
      generatedPackage
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

// Execute script
app.post('/api/execute/:owner/:repo/:filePath(*)', async (req, res) => {
  try {
    const { owner, repo, filePath } = req.params;
    const { branch = 'main', args = [] } = req.body;
    
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
    const response = await makeGitHubRequest(url);
    const scriptContent = Buffer.from(response.data.content, 'base64').toString('utf-8');
    
    // Execute in sandbox
    const output = [];
    const errors = [];
    
    const sandbox = {
      console: {
        log: (...args) => output.push(args.join(' ')),
        error: (...args) => errors.push(args.join(' ')),
        warn: (...args) => output.push(`WARN: ${args.join(' ')}`)
      },
      process: {
        env: process.env,
        argv: ['node', filePath, ...args],
        cwd: () => process.cwd()
      },
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
      setInterval: setInterval,
      clearInterval: clearInterval,
      module: { exports: {} },
      exports: {},
      require: (moduleName) => {
        const safeModules = ['fs', 'path', 'util', 'crypto', 'url', 'querystring', 'os'];
        if (safeModules.includes(moduleName)) {
          return require(moduleName);
        }
        throw new Error(`Module "${moduleName}" not available in sandbox`);
      },
      args: args,
      __filename: filePath,
      __dirname: path.dirname(filePath)
    };
    
    const startTime = Date.now();
    try {
      const script = new vm.Script(scriptContent);
      const context = vm.createContext(sandbox);
      script.runInContext(context, { timeout: 5000, displayErrors: true });
      
      const executionTime = Date.now() - startTime;
      const executionRecord = {
        id: Date.now(),
        script: `${owner}/${repo}/${filePath}`,
        branch, args,
        result: { success: true, output: output.join('\n') },
        executionTime,
        timestamp: new Date().toISOString()
      };
      executionHistory.unshift(executionRecord);
      
      res.json({
        success: true,
        execution: {
          output: output.join('\n'),
          errors: errors.join('\n'),
          executionTime: `${executionTime}ms`,
          timestamp: new Date().toISOString()
        },
        executionId: executionRecord.id
      });
    } catch (execError) {
      res.status(400).json({
        success: false,
        error: execError.message,
        stack: execError.stack,
        output: output.join('\n')
      });
    }
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

// Serve web interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>GitHub Script Loader - Fixed Token Auth</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
        .token-status { padding: 15px; margin-bottom: 20px; border-radius: 6px; }
        .token-status.valid { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .token-status.invalid { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        .token-status.warning { background: #fff3cd; color: #856404; border: 1px solid #ffeeba; }
        input, button { padding: 10px; margin: 5px; }
        input { width: calc(100% - 24px); }
        button { background: #0366d6; color: white; border: none; cursor: pointer; border-radius: 4px; }
        button:hover { background: #0255b3; }
        .file-list { margin-top: 20px; }
        .file-item { padding: 10px; border-bottom: 1px solid #e1e4e8; cursor: pointer; }
        .file-item:hover { background: #f6f8fa; }
        pre { background: #f6f8fa; padding: 15px; overflow-x: auto; border-radius: 4px; }
        .error { color: red; }
        .success { color: green; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🔧 GitHub Script Loader - Fixed Authentication</h1>
        <div id="tokenStatus" class="token-status">Loading token status...</div>
        
        <div>
          <h3>📁 Browse Repository</h3>
          <input type="text" id="repoInput" placeholder="owner/repo (e.g., facebook/react)" />
          <button onclick="loadRepository()">Browse</button>
        </div>
        
        <div id="content"></div>
      </div>
      
      <script>
        async function checkToken() {
          const response = await fetch('/api/test-token');
          const data = await response.json();
          const statusDiv = document.getElementById('tokenStatus');
          
          if (!data.hasToken) {
            statusDiv.className = 'token-status warning';
            statusDiv.innerHTML = \`
              ⚠️ No GitHub Token Configured<br>
              <strong>Rate Limit: 60 requests/hour</strong><br><br>
              <strong>To add a token:</strong><br>
              1. Go to <a href="https://github.com/settings/tokens" target="_blank">GitHub Tokens</a><br>
              2. Generate new classic token<br>
              3. Select 'repo' and 'public_repo' scopes<br>
              4. Add to .env file: GITHUB_TOKEN=your_token_here<br>
              5. Restart the server
            \`;
          } else if (data.tokenValid) {
            statusDiv.className = 'token-status valid';
            statusDiv.innerHTML = \`✅ GitHub Token Active | Token: \${data.tokenPrefix}<br>Working correctly with higher rate limits\`;
          } else {
            statusDiv.className = 'token-status invalid';
            statusDiv.innerHTML = \`
              ❌ Invalid GitHub Token<br>
              Error: \${data.error || 'Bad credentials'}<br><br>
              <strong>To fix:</strong><br>
              1. Go to <a href="https://github.com/settings/tokens" target="_blank">GitHub Tokens</a><br>
              2. Delete the old token<br>
              3. Generate a NEW classic token<br>
              4. Select 'repo' and 'public_repo' scopes<br>
              5. Update .env file with the NEW token<br>
              6. Restart the server
            \`;
          }
        }
        
        async function loadRepository() {
          const repoInput = document.getElementById('repoInput').value;
          if (!repoInput) return;
          
          const [owner, repo] = repoInput.split('/');
          const contentDiv = document.getElementById('content');
          contentDiv.innerHTML = '<div class="loading">Loading...</div>';
          
          try {
            const response = await fetch(\`/api/browse/\${owner}/\${repo}\`);
            const data = await response.json();
            
            if (data.success) {
              contentDiv.innerHTML = \`
                <div class="file-list">
                  <h3>📂 \${owner}/\${repo}</h3>
                  <p>⭐ \${data.repository.stars} stars | 🍴 \${data.repository.forks} forks</p>
                  \${data.items.map(item => \`
                    <div class="file-item" onclick="loadFile('\${item.path}')">
                      \${item.type === 'dir' ? '📁' : '📄'} \${item.name}
                      \${item.isExecutable ? ' [EXECUTABLE]' : ''}
                    </div>
                  \`).join('')}
                </div>
              \`;
            } else {
              contentDiv.innerHTML = \`<div class="error">Error: \${data.error}</div>\`;
            }
          } catch (error) {
            contentDiv.innerHTML = \`<div class="error">Error: \${error.message}</div>\`;
          }
        }
        
        async function loadFile(filePath) {
          const repoInput = document.getElementById('repoInput').value;
          const [owner, repo] = repoInput.split('/');
          const contentDiv = document.getElementById('content');
          
          const response = await fetch(\`/api/file/\${owner}/\${repo}/\${filePath}\`);
          const data = await response.json();
          
          if (data.success) {
            contentDiv.innerHTML = \`
              <h3>📄 \${data.file.name}</h3>
              <p>Size: \${data.file.size} bytes | Lines: \${data.file.lines}</p>
              \${data.file.isExecutable ? \`
                <button onclick="executeScript('\${filePath}')">▶ Execute Script</button>
                <button onclick="generatePackage('\${filePath}')">📦 Generate package.json</button>
              \` : ''}
              <pre>\${escapeHtml(data.file.content)}</pre>
              <h3>📜 History</h3>
              \${data.history.map(commit => \`
                <div style="padding: 10px; border-bottom: 1px solid #e1e4e8;">
                  <strong>\${commit.short_sha}</strong> - \${commit.message}<br>
                  <small>\${commit.author} - \${new Date(commit.date).toLocaleString()}</small>
                </div>
              \`).join('')}
            \`;
          }
        }
        
        async function executeScript(filePath) {
          const repoInput = document.getElementById('repoInput').value;
          const [owner, repo] = repoInput.split('/');
          
          const response = await fetch(\`/api/execute/\${owner}/\${repo}/\${filePath}\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args: [] })
          });
          
          const data = await response.json();
          if (data.success) {
            alert(\`Execution completed!\\n\\nOutput:\\n\${data.execution.output}\`);
          } else {
            alert(\`Execution failed: \${data.error}\`);
          }
        }
        
        async function generatePackage(filePath) {
          const repoInput = document.getElementById('repoInput').value;
          const [owner, repo] = repoInput.split('/');
          
          const response = await fetch('/api/generate-package', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ owner, repo, scriptPath: filePath })
          });
          
          const data = await response.json();
          if (data.success) {
            alert(\`package.json generated!\\n\\nDependencies: \${Object.keys(data.packageJson.dependencies).join(', ') || 'none'}\\n\\nInstall: \${data.installCommand}\`);
          } else {
            alert(\`Failed: \${data.error}\`);
          }
        }
        
        function escapeHtml(text) {
          const div = document.createElement('div');
          div.textContent = text;
          return div.innerHTML;
        }
        
        checkToken();
      </script>
    </body>
    </html>
  `);
});

// Start server with token validation
async function startServer() {
  console.log('\n========================================');
  console.log('🔧 GitHub Script Loader Server');
  console.log('========================================');
  
  // Test token on startup
  const tokenValid = await testTokenValidity();
  
  if (!GITHUB_TOKEN) {
    console.log('\n⚠️  WARNING: No GitHub token configured');
    console.log('   Rate limit: 60 requests/hour');
    console.log('\n   To add a token:');
    console.log('   1. Visit: https://github.com/settings/tokens');
    console.log('   2. Generate new classic token');
    console.log('   3. Select "repo" and "public_repo" scopes');
    console.log('   4. Add to .env file: GITHUB_TOKEN=your_token');
    console.log('   5. Restart the server\n');
  } else if (!tokenValid) {
    console.log('\n❌ ERROR: Invalid GitHub token!');
    console.log('   The token provided is not working.');
    console.log('\n   To fix:');
    console.log('   1. Visit: https://github.com/settings/tokens');
    console.log('   2. Delete the old token');
    console.log('   3. Generate a NEW classic token');
    console.log('   4. Make sure to select "repo" scope');
    console.log('   5. Update .env file with the NEW token');
    console.log('   6. Restart the server\n');
  } else {
    console.log('\n✅ GitHub token is valid and working!');
    console.log('   Rate limit: 5000 requests/hour\n');
  }
  
  app.listen(PORT, () => {
    console.log(`📡 Server running at: http://localhost:${PORT}`);
    console.log('========================================\n');
  });
}

startServer();
