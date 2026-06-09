// server.js - Complete GitHub Script Loader with Execution & Package.json Generator
const express = require('express');
const axios = require('axios');
const { Octokit } = require('@octokit/rest');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

// Load .env file
try {
  if (fs.existsSync('.env')) {
    require('dotenv').config();
    console.log('✅ Loaded configuration from .env file');
  }
} catch (err) {
  console.log('No .env file found, using environment variables');
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;
const ALLOW_SCRIPT_EXECUTION = process.env.ALLOW_SCRIPT_EXECUTION !== 'false';

// Initialize Octokit
const octokit = new Octokit({
  auth: GITHUB_TOKEN,
  userAgent: 'GitHub-Script-Loader-App'
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Store execution history
let executionHistory = [];
let generatedPackages = [];

// ============================================
// PACKAGE.JSON GENERATOR
// ============================================

function analyzeAndGeneratePackageJson(scriptContent, scriptPath) {
  const packageJson = {
    name: path.basename(scriptPath, path.extname(scriptPath)),
    version: "1.0.0",
    description: "Auto-generated package.json from GitHub script",
    main: scriptPath,
    scripts: {
      start: `node ${scriptPath}`,
      test: "echo \"Error: no test specified\" && exit 1"
    },
    dependencies: {},
    devDependencies: {},
    keywords: ["github", "script", "auto-generated"],
    author: "",
    license: "ISC"
  };
  
  // Analyze require/import statements
  const requireMatches = scriptContent.match(/require\(['"]([^'"]+)['"]\)/g) || [];
  const importMatches = scriptContent.match(/from ['"]([^'"]+)['"]/g) || [];
  const dynamicImports = scriptContent.match(/import\(['"]([^'"]+)['"]\)/g) || [];
  
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
  
  dynamicImports.forEach(match => {
    const module = match.match(/import\(['"]([^'"]+)['"]\)/)[1];
    if (!module.startsWith('.') && !module.startsWith('/')) {
      allModules.push(module);
    }
  });
  
  // Remove duplicates and add to dependencies
  const uniqueModules = [...new Set(allModules)];
  uniqueModules.forEach(module => {
    packageJson.dependencies[module] = "*";
  });
  
  // Check for specific frameworks
  if (scriptContent.includes('express')) {
    packageJson.dependencies.express = "^4.18.2";
    packageJson.scripts.start = `node ${scriptPath}`;
    packageJson.scripts.dev = "nodemon ${scriptPath}";
    packageJson.devDependencies.nodemon = "^3.0.1";
  }
  
  if (scriptContent.includes('react') || scriptContent.includes('jsx')) {
    packageJson.dependencies.react = "^18.2.0";
    packageJson.dependencies["react-dom"] = "^18.2.0";
    packageJson.scripts.build = "webpack --mode production";
  }
  
  if (scriptContent.includes('axios')) {
    packageJson.dependencies.axios = "^1.6.0";
  }
  
  if (scriptContent.includes('lodash')) {
    packageJson.dependencies.lodash = "^4.17.21";
  }
  
  if (scriptContent.includes('mongoose')) {
    packageJson.dependencies.mongoose = "^8.0.0";
  }
  
  if (scriptContent.includes('socket.io')) {
    packageJson.dependencies["socket.io"] = "^4.5.0";
  }
  
  return packageJson;
}

// Generate package.json from GitHub script
app.post('/api/generate-package', async (req, res) => {
  try {
    const { owner, repo, scriptPath, branch = 'main' } = req.body;
    
    // Fetch script content
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: scriptPath,
      ref: branch
    });
    
    const scriptContent = Buffer.from(response.data.content, 'base64').toString('utf-8');
    const packageJson = analyzeAndGeneratePackageJson(scriptContent, scriptPath);
    
    // Store generated package
    const generatedPackage = {
      id: Date.now(),
      owner,
      repo,
      scriptPath,
      branch,
      packageJson,
      generatedAt: new Date().toISOString()
    };
    generatedPackages.unshift(generatedPackage);
    
    res.json({
      success: true,
      packageJson,
      message: 'package.json generated successfully!',
      installCommand: `npm install ${Object.keys(packageJson.dependencies).join(' ')}`,
      generatedPackage: generatedPackage
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

// Download generated package.json
app.get('/api/download-package/:id', (req, res) => {
  const package = generatedPackages.find(p => p.id == req.params.id);
  if (!package) {
    return res.status(404).json({ error: 'Package not found' });
  }
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="package.json"`);
  res.json(package.packageJson);
});

// ============================================
// SCRIPT EXECUTION
// ============================================

async function executeJavaScript(code, filename, args = []) {
  return new Promise((resolve, reject) => {
    const output = [];
    const errors = [];
    
    const sandbox = {
      console: {
        log: (...args) => {
          const msg = args.join(' ');
          output.push(msg);
          console.log(`[Script:${filename}]`, msg);
        },
        error: (...args) => {
          const msg = args.join(' ');
          errors.push(msg);
          console.error(`[Script:${filename}]`, msg);
        },
        warn: (...args) => {
          const msg = args.join(' ');
          output.push(`WARN: ${msg}`);
          console.warn(`[Script:${filename}]`, msg);
        }
      },
      process: {
        env: process.env,
        argv: ['node', filename, ...args],
        cwd: () => process.cwd(),
        exit: (code) => { throw new Error(`Script attempted to exit with code ${code}`); }
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
        throw new Error(`Module "${moduleName}" is not allowed. Please install locally first.`);
      },
      args: args,
      __filename: filename,
      __dirname: path.dirname(filename)
    };
    
    try {
      const script = new vm.Script(code);
      const context = vm.createContext(sandbox);
      script.runInContext(context, {
        timeout: 5000,
        displayErrors: true
      });
      
      resolve({
        success: true,
        output: output.join('\n'),
        errors: errors.join('\n'),
        exports: sandbox.module.exports,
        timestamp: new Date()
      });
    } catch (error) {
      reject({
        success: false,
        error: error.message,
        stack: error.stack,
        output: output.join('\n'),
        timestamp: new Date()
      });
    }
  });
}

// Execute script from GitHub
app.post('/api/execute/:owner/:repo/:filePath(*)', async (req, res) => {
  if (!ALLOW_SCRIPT_EXECUTION) {
    return res.status(403).json({
      success: false,
      error: 'Script execution is disabled on this server'
    });
  }
  
  try {
    const { owner, repo, filePath } = req.params;
    const { branch = 'main', args = [], useGeneratedPackage = false, packageJson } = req.body;
    
    // Fetch script content
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: branch
    });
    
    const scriptContent = Buffer.from(response.data.content, 'base64').toString('utf-8');
    
    // Generate package.json if requested
    let generatedPackage = null;
    if (useGeneratedPackage) {
      generatedPackage = analyzeAndGeneratePackageJson(scriptContent, filePath);
    }
    
    // Execute script
    const startTime = Date.now();
    const result = await executeJavaScript(scriptContent, filePath, args);
    const executionTime = Date.now() - startTime;
    
    // Store execution history
    const executionRecord = {
      id: Date.now(),
      script: `${owner}/${repo}/${filePath}`,
      branch,
      args,
      result: result,
      executionTime,
      timestamp: new Date().toISOString()
    };
    executionHistory.unshift(executionRecord);
    
    res.json({
      success: result.success,
      execution: {
        output: result.output,
        errors: result.errors || result.error,
        executionTime: `${executionTime}ms`,
        timestamp: new Date().toISOString()
      },
      generatedPackage: generatedPackage,
      executionId: executionRecord.id
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

// Get execution history
app.get('/api/execution-history', (req, res) => {
  res.json({
    success: true,
    history: executionHistory.slice(0, 50)
  });
});

// Get generated packages history
app.get('/api/generated-packages', (req, res) => {
  res.json({
    success: true,
    packages: generatedPackages
  });
});

// ============================================
// GITHUB BROWSING ENDPOINTS
// ============================================

app.get('/api/rate-limit', async (req, res) => {
  try {
    const rateLimit = await octokit.rest.rateLimit.get();
    res.json({
      authenticated: !!GITHUB_TOKEN,
      rate: rateLimit.data.resources.core,
      execution_enabled: ALLOW_SCRIPT_EXECUTION
    });
  } catch (error) {
    res.json({ authenticated: false, error: error.message });
  }
});

app.get('/api/browse/:owner/:repo', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { path: filePath = '', branch = 'main' } = req.query;
    
    const response = await octokit.rest.repos.getContent({
      owner, repo, path: filePath, ref: branch
    });
    
    const contents = Array.isArray(response.data) ? response.data : [response.data];
    
    const items = contents.map(item => ({
      name: item.name,
      path: item.path,
      type: item.type,
      size: item.size,
      extension: path.extname(item.name),
      isExecutable: ['.js', '.mjs', '.cjs', '.ts', '.py', '.rb', '.sh'].includes(path.extname(item.name))
    }));
    
    const repoInfo = await octokit.rest.repos.get({ owner, repo });
    
    res.json({
      success: true, owner, repo, branch,
      currentPath: filePath, items,
      repository: {
        name: repoInfo.data.name,
        description: repoInfo.data.description,
        stars: repoInfo.data.stargazers_count,
        forks: repoInfo.data.forks_count
      }
    });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
});

app.get('/api/file/:owner/:repo/:filePath(*)', async (req, res) => {
  try {
    const { owner, repo, filePath } = req.params;
    const { branch = 'main', commit } = req.query;
    
    const response = await octokit.rest.repos.getContent({
      owner, repo, path: filePath, ref: commit || branch
    });
    
    const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
    
    const commits = await octokit.rest.repos.listCommits({
      owner, repo, path: filePath, sha: branch, per_page: 30
    });
    
    const history = commits.data.map(commit => ({
      sha: commit.sha, short_sha: commit.sha.substring(0, 7),
      message: commit.commit.message, date: commit.commit.author.date,
      author: commit.commit.author.name
    }));
    
    res.json({
      success: true,
      file: {
        name: path.basename(filePath), path: filePath, content: content,
        size: content.length, lines: content.split('\n').length,
        extension: path.extname(filePath),
        isExecutable: ['.js', '.mjs', '.cjs'].includes(path.extname(filePath))
      },
      history, branch
    });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
});

// ============================================
// WEB INTERFACE
// ============================================

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>GitHub Script Loader - Execute & Generate Package.json</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden; }
        .header { background: linear-gradient(135deg, #24292e 0%, #1a1e22 100%); color: white; padding: 30px; }
        .header h1 { font-size: 28px; margin-bottom: 10px; }
        .token-status { background: rgba(255,255,255,0.1); padding: 10px; border-radius: 6px; margin-top: 15px; font-size: 14px; }
        .main-content { display: flex; height: calc(100vh - 200px); min-height: 600px; }
        .sidebar { width: 300px; background: #f6f8fa; border-right: 1px solid #e1e4e8; overflow-y: auto; padding: 20px; }
        .browser { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
        .toolbar { padding: 20px; background: white; border-bottom: 1px solid #e1e4e8; }
        .repo-input { display: flex; gap: 10px; margin-bottom: 15px; }
        .repo-input input { flex: 1; padding: 10px; border: 2px solid #e1e4e8; border-radius: 6px; }
        .repo-input button { padding: 10px 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; }
        .file-list { flex: 1; overflow-y: auto; padding: 20px; }
        .file-item { display: flex; align-items: center; padding: 12px; border-bottom: 1px solid #e1e4e8; cursor: pointer; transition: background 0.2s; }
        .file-item:hover { background: #f6f8fa; }
        .file-icon { width: 24px; margin-right: 12px; font-size: 18px; }
        .file-name { flex: 1; font-size: 14px; }
        .executable-badge { background: #28a745; color: white; padding: 2px 8px; border-radius: 12px; font-size: 11px; margin-left: 10px; }
        .content-panel { flex: 1; overflow-y: auto; padding: 20px; background: #f6f8fa; }
        .history-panel { width: 350px; background: white; border-left: 1px solid #e1e4e8; overflow-y: auto; padding: 20px; }
        .commit-item { padding: 12px; border-bottom: 1px solid #e1e4e8; cursor: pointer; }
        .commit-item:hover { background: #f6f8fa; }
        .execution-controls { margin-top: 20px; padding: 15px; background: #f6f8fa; border-radius: 6px; }
        .execution-controls input, .execution-controls select { padding: 8px; margin: 5px; border: 1px solid #e1e4e8; border-radius: 4px; }
        .execution-controls button { background: #28a745; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; margin: 5px; }
        .generate-package-btn { background: #6f42c1; }
        .execute-btn { background: #28a745; }
        .output { background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 6px; font-family: 'Courier New', monospace; font-size: 12px; margin-top: 15px; max-height: 400px; overflow-y: auto; }
        pre { white-space: pre-wrap; word-wrap: break-word; }
        .spinner { border: 3px solid #f3f3f3; border-top: 3px solid #667eea; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .success { color: #28a745; }
        .error { color: #dc3545; }
        button { transition: all 0.3s; }
        button:hover { transform: translateY(-2px); box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🚀 GitHub Script Loader with Execution & Package.json Generator</h1>
          <p>Browse, execute, and generate package.json from any GitHub repository</p>
          <div id="tokenStatus" class="token-status"></div>
        </div>
        
        <div class="main-content">
          <div class="sidebar">
            <h3>📊 Execution History</h3>
            <div id="executionHistory"></div>
            <hr style="margin: 20px 0;">
            <h3>📦 Generated Packages</h3>
            <div id="generatedPackagesList"></div>
          </div>
          
          <div class="browser">
            <div class="toolbar">
              <div class="repo-input">
                <input type="text" id="repoInput" placeholder="owner/repository (e.g., facebook/react)" />
                <button onclick="loadRepository()">Browse</button>
              </div>
              <div>
                <select id="branchSelect" onchange="changeBranch()" style="padding: 8px; width: 200px;"></select>
              </div>
            </div>
            
            <div class="file-list" id="fileList">
              <div class="loading" style="text-align: center; padding: 40px;">Enter a repository to start browsing...</div>
            </div>
          </div>
          
          <div class="content-panel" id="contentPanel" style="display: none;">
            <div id="fileContent"></div>
            <div class="execution-controls" id="executionControls" style="display: none;">
              <h4>⚡ Execute Script</h4>
              <input type="text" id="execArgs" placeholder="Command line arguments (space separated)" style="width: 100%; margin-bottom: 10px;">
              <div>
                <button class="generate-package-btn" onclick="generatePackageJson()">📦 Generate package.json</button>
                <button class="execute-btn" onclick="executeScript()">▶ Execute Script</button>
                <button class="execute-btn" onclick="executeWithPackage()">📦 Execute with Generated package.json</button>
              </div>
              <div id="executionOutput" class="output" style="display: none;"></div>
            </div>
          </div>
          
          <div class="history-panel" id="historyPanel" style="display: none;">
            <h3>📜 File History</h3>
            <div id="commitHistory"></div>
          </div>
        </div>
      </div>
      
      <script>
        let currentOwner = '', currentRepo = '', currentBranch = 'main', currentFilePath = '', currentFileContent = '';
        
        async function loadTokenStatus() {
          const response = await fetch('/api/rate-limit');
          const data = await response.json();
          const statusDiv = document.getElementById('tokenStatus');
          if (data.authenticated) {
            statusDiv.innerHTML = \`✅ GitHub Token Active | \${data.rate.remaining}/\${data.rate.limit} requests remaining\`;
          } else {
            statusDiv.innerHTML = \`⚠️ No GitHub Token | Limited to 60 requests/hour\`;
          }
        }
        
        async function loadRepository() {
          const repoInput = document.getElementById('repoInput').value.trim();
          if (!repoInput) return alert('Enter repository (owner/repo)');
          const [owner, repo] = repoInput.split('/');
          if (!owner || !repo) return alert('Use format: owner/repo');
          
          currentOwner = owner; currentRepo = repo;
          await browsePath('');
          await loadBranches();
          await loadExecutionHistory();
          await loadGeneratedPackages();
        }
        
        async function browsePath(path) {
          const fileListDiv = document.getElementById('fileList');
          fileListDiv.innerHTML = '<div class="spinner"></div>';
          
          const response = await fetch(\`/api/browse/\${currentOwner}/\${currentRepo}?path=\${encodeURIComponent(path)}&branch=\${currentBranch}\`);
          const data = await response.json();
          
          if (data.success) {
            displayFileList(data.items);
            document.getElementById('contentPanel').style.display = 'none';
            document.getElementById('historyPanel').style.display = 'none';
          } else {
            fileListDiv.innerHTML = \`<div class="error">❌ \${data.error}</div>\`;
          }
        }
        
        function displayFileList(items) {
          const fileListDiv = document.getElementById('fileList');
          fileListDiv.innerHTML = items.map(item => \`
            <div class="file-item" onclick="openItem('\${item.type}', '\${item.path}')">
              <div class="file-icon">\${item.type === 'dir' ? '📁' : '📄'}</div>
              <div class="file-name">\${item.name}</div>
              \${item.isExecutable ? '<span class="executable-badge">▶ Executable</span>' : ''}
            </div>
          \`).join('');
        }
        
        async function loadBranches() {
          // Simplified - just try common branches
          const branchSelect = document.getElementById('branchSelect');
          branchSelect.innerHTML = '<option value="main">main</option><option value="master">master</option>';
        }
        
        function changeBranch() {
          currentBranch = document.getElementById('branchSelect').value;
          browsePath('');
        }
        
        async function openItem(type, path) {
          if (type === 'dir') {
            browsePath(path);
          } else {
            await loadFile(path);
          }
        }
        
        async function loadFile(filePath) {
          currentFilePath = filePath;
          const response = await fetch(\`/api/file/\${currentOwner}/\${currentRepo}/\${filePath}?branch=\${currentBranch}\`);
          const data = await response.json();
          
          if (data.success) {
            currentFileContent = data.file.content;
            document.getElementById('contentPanel').style.display = 'block';
            document.getElementById('historyPanel').style.display = 'block';
            document.getElementById('executionControls').style.display = data.file.isExecutable ? 'block' : 'none';
            
            document.getElementById('fileContent').innerHTML = \`
              <h3>📄 \${data.file.name}</h3>
              <p><strong>Size:</strong> \${data.file.size} bytes | <strong>Lines:</strong> \${data.file.lines}</p>
              <pre>\${escapeHtml(data.file.content.substring(0, 5000))}\${data.file.content.length > 5000 ? '\\n\\n... (truncated)' : ''}</pre>
            \`;
            
            document.getElementById('commitHistory').innerHTML = data.history.map(commit => \`
              <div class="commit-item" onclick="loadCommitVersion('\${commit.sha}')">
                <strong>\${commit.short_sha}</strong><br>
                \${commit.message.substring(0, 80)}<br>
                <small>\${commit.author} - \${new Date(commit.date).toLocaleDateString()}</small>
              </div>
            \`).join('');
          }
        }
        
        async function generatePackageJson() {
          const response = await fetch('/api/generate-package', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              owner: currentOwner,
              repo: currentRepo,
              scriptPath: currentFilePath,
              branch: currentBranch
            })
          });
          
          const data = await response.json();
          if (data.success) {
            alert(\`✅ package.json generated!\\n\\nInstall with: \${data.installCommand}\\n\\nDependencies detected: \${Object.keys(data.packageJson.dependencies).join(', ') || 'none'}\`);
            document.getElementById('executionOutput').style.display = 'block';
            document.getElementById('executionOutput').innerHTML = \`
              <div class="success">✅ Generated package.json:</div>
              <pre>\${JSON.stringify(data.packageJson, null, 2)}</pre>
            \`;
            await loadGeneratedPackages();
          } else {
            alert('Error: ' + data.error);
          }
        }
        
        async function executeScript() {
          const args = document.getElementById('execArgs').value.split(' ').filter(a => a);
          const outputDiv = document.getElementById('executionOutput');
          outputDiv.style.display = 'block';
          outputDiv.innerHTML = '<div class="spinner"></div><div>Executing script...</div>';
          
          const response = await fetch(\`/api/execute/\${currentOwner}/\${currentRepo}/\${currentFilePath}?branch=\${currentBranch}\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args: args, useGeneratedPackage: false })
          });
          
          const data = await response.json();
          if (data.success) {
            outputDiv.innerHTML = \`
              <div class="success">✅ Execution completed in \${data.execution.executionTime}</div>
              <div style="margin-top: 10px;"><strong>Output:</strong></div>
              <pre>\${escapeHtml(data.execution.output || 'No output')}</pre>
              \${data.execution.errors ? \`<div class="error"><strong>Errors:</strong></div><pre>\${escapeHtml(data.execution.errors)}</pre>\` : ''}
            \`;
          } else {
            outputDiv.innerHTML = \`<div class="error">❌ Execution failed: \${data.error}</div><pre>\${escapeHtml(data.stack || '')}</pre>\`;
          }
          await loadExecutionHistory();
        }
        
        async function executeWithPackage() {
          const args = document.getElementById('execArgs').value.split(' ').filter(a => a);
          const outputDiv = document.getElementById('executionOutput');
          outputDiv.style.display = 'block';
          outputDiv.innerHTML = '<div class="spinner"></div><div>Generating package.json and executing...</div>';
          
          // First generate package.json
          const genResponse = await fetch('/api/generate-package', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              owner: currentOwner,
              repo: currentRepo,
              scriptPath: currentFilePath,
              branch: currentBranch
            })
          });
          
          const genData = await genResponse.json();
          if (!genData.success) {
            outputDiv.innerHTML = \`<div class="error">Failed to generate package.json: \${genData.error}</div>\`;
            return;
          }
          
          // Execute with generated package info
          const response = await fetch(\`/api/execute/\${currentOwner}/\${currentRepo}/\${currentFilePath}?branch=\${currentBranch}\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              args: args, 
              useGeneratedPackage: true,
              packageJson: genData.packageJson
            })
          });
          
          const data = await response.json();
          if (data.success) {
            outputDiv.innerHTML = \`
              <div class="success">✅ Execution completed with generated package.json!</div>
              <div style="margin-top: 10px;"><strong>Generated Dependencies:</strong> \${Object.keys(genData.packageJson.dependencies).join(', ') || 'none'}</div>
              <div style="margin-top: 10px;"><strong>Output:</strong></div>
              <pre>\${escapeHtml(data.execution.output || 'No output')}</pre>
            \`;
          } else {
            outputDiv.innerHTML = \`<div class="error">❌ Execution failed: \${data.error}</div>\`;
          }
          await loadExecutionHistory();
        }
        
        async function loadExecutionHistory() {
          const response = await fetch('/api/execution-history');
          const data = await response.json();
          const historyDiv = document.getElementById('executionHistory');
          if (data.history.length === 0) {
            historyDiv.innerHTML = '<div style="font-size: 12px; color: #586069;">No executions yet</div>';
          } else {
            historyDiv.innerHTML = data.history.slice(0, 10).map(exec => \`
              <div style="padding: 10px; margin-bottom: 10px; background: white; border-radius: 4px; font-size: 12px;">
                <strong>\${exec.script.split('/').pop()}</strong><br>
                <small>\${new Date(exec.timestamp).toLocaleString()}</small><br>
                <span class="\${exec.result.success ? 'success' : 'error'}">\${exec.result.success ? '✅ Success' : '❌ Failed'}</span>
              </div>
            \`).join('');
          }
        }
        
        async function loadGeneratedPackages() {
          const response = await fetch('/api/generated-packages');
          const data = await response.json();
          const packagesDiv = document.getElementById('generatedPackagesList');
          if (data.packages.length === 0) {
            packagesDiv.innerHTML = '<div style="font-size: 12px; color: #586069;">No packages generated yet</div>';
          } else {
            packagesDiv.innerHTML = data.packages.slice(0, 5).map(pkg => \`
              <div style="padding: 10px; margin-bottom: 10px; background: white; border-radius: 4px; font-size: 12px;">
                <strong>\${pkg.scriptPath.split('/').pop()}</strong><br>
                <small>\${Object.keys(pkg.packageJson.dependencies).length} dependencies</small><br>
                <a href="/api/download-package/\${pkg.id}" download style="color: #0366d6;">📥 Download package.json</a>
              </div>
            \`).join('');
          }
        }
        
        function escapeHtml(text) { return text ? String(text).replace(/[&<>]/g, function(m) { if (m === '&') return '&amp;'; if (m === '<') return '&lt;'; if (m === '>') return '&gt;'; return m; }) : ''; }
        
        loadTokenStatus();
        setInterval(loadTokenStatus, 60000);
      </script>
    </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log('\n========================================');
  console.log('🚀 GitHub Script Loader Server Started');
  console.log('========================================');
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🔑 GitHub Token: ${GITHUB_TOKEN ? '✅ Active' : '❌ Not set'}`);
  console.log(`⚡ Script Execution: ${ALLOW_SCRIPT_EXECUTION ? '✅ Enabled' : '❌ Disabled'}`);
  console.log('\n✨ Features:');
  console.log('  • Browse any GitHub repository');
  console.log('  • View file content and history');
  console.log('  • Execute JavaScript files directly');
  console.log('  • Auto-generate package.json from dependencies');
  console.log('  • Download generated package.json');
  console.log('\n========================================\n');
});
