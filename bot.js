// server.js
const express = require('express');
const axios = require('axios');
const { Octokit } = require('@octokit/rest');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// GITHUB TOKEN SETUP
// ============================================
// Option 1: Set as environment variable
// Run: export GITHUB_TOKEN=your_token_here
// 
// Option 2: Create a .env file (recommended)
// Create .env file with: GITHUB_TOKEN=your_token_here
//
// Option 3: Hardcode for testing (not recommended for production)
// const GITHUB_TOKEN = 'your_token_here';

// Load from .env file if exists
try {
  if (fs.existsSync('.env')) {
    require('dotenv').config();
    console.log('✅ Loaded configuration from .env file');
  }
} catch (err) {
  console.log('No .env file found, using environment variables');
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;

// Initialize Octokit with token if available
const octokit = new Octokit({
  auth: GITHUB_TOKEN,
  userAgent: 'GitHub-Script-Loader-App'
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Store recently viewed repositories
let recentRepos = [];

// Helper function to check if token is configured
function isTokenConfigured() {
  return GITHUB_TOKEN && GITHUB_TOKEN.length > 0;
}

// API endpoint to get rate limit info
app.get('/api/rate-limit', async (req, res) => {
  try {
    const rateLimit = await octokit.rest.rateLimit.get();
    res.json({
      authenticated: isTokenConfigured(),
      rate: rateLimit.data.resources.core,
      token_info: isTokenConfigured() ? 'Token is configured - Higher rate limits apply' : 'No token - Limited to 60 requests/hour'
    });
  } catch (error) {
    res.json({
      authenticated: false,
      error: error.message
    });
  }
});

// API endpoint to browse repository contents
app.get('/api/browse/:owner/:repo', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { path: filePath = '', branch = 'main' } = req.query;
    
    // Add to recent repos
    const repoKey = `${owner}/${repo}`;
    if (!recentRepos.includes(repoKey)) {
      recentRepos.unshift(repoKey);
      recentRepos = recentRepos.slice(0, 10);
    }
    
    // Get contents of directory
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: branch
    });
    
    const contents = Array.isArray(response.data) ? response.data : [response.data];
    
    const items = contents.map(item => ({
      name: item.name,
      path: item.path,
      type: item.type,
      size: item.size,
      sha: item.sha,
      download_url: item.download_url,
      html_url: item.html_url
    }));
    
    // Get repository info
    const repoInfo = await octokit.rest.repos.get({
      owner,
      repo
    });
    
    res.json({
      success: true,
      owner,
      repo,
      branch,
      currentPath: filePath,
      items,
      repository: {
        name: repoInfo.data.name,
        description: repoInfo.data.description,
        default_branch: repoInfo.data.default_branch,
        stars: repoInfo.data.stargazers_count,
        forks: repoInfo.data.forks_count,
        url: repoInfo.data.html_url
      }
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message,
      hint: 'Try a different branch name or check if repository exists'
    });
  }
});

// API endpoint to get file content and history
app.get('/api/file/:owner/:repo/:filePath(*)', async (req, res) => {
  try {
    const { owner, repo, filePath } = req.params;
    const { branch = 'main', commit } = req.query;
    
    // Get file content
    let content, sha;
    try {
      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: commit || branch
      });
      
      content = Buffer.from(response.data.content, 'base64').toString('utf-8');
      sha = response.data.sha;
    } catch (error) {
      throw new Error(`File not found: ${error.message}`);
    }
    
    // Get file history (commits)
    const commits = await octokit.rest.repos.listCommits({
      owner,
      repo,
      path: filePath,
      sha: branch,
      per_page: 30
    });
    
    const history = commits.data.map(commit => ({
      sha: commit.sha,
      short_sha: commit.sha.substring(0, 7),
      message: commit.commit.message,
      date: commit.commit.author.date,
      author: commit.commit.author.name,
      author_email: commit.commit.author.email,
      url: commit.html_url,
      additions: commit.stats?.additions || 0,
      deletions: commit.stats?.deletions || 0
    }));
    
    // Get file details
    const fileExtension = path.extname(filePath);
    const isBinary = ['.jpg', '.png', '.gif', '.pdf', '.zip'].includes(fileExtension);
    
    res.json({
      success: true,
      file: {
        name: path.basename(filePath),
        path: filePath,
        content: isBinary ? null : content,
        sha,
        size: content.length,
        lines: content.split('\n').length,
        extension: fileExtension,
        isBinary
      },
      history,
      branch,
      repository: `${owner}/${repo}`
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to get specific commit version
app.get('/api/file-version/:owner/:repo/:filePath(*)/commit/:commitSha', async (req, res) => {
  try {
    const { owner, repo, filePath, commitSha } = req.params;
    
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: commitSha
    });
    
    const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
    
    res.json({
      success: true,
      content,
      sha: response.data.sha,
      commit: commitSha
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to get branches
app.get('/api/branches/:owner/:repo', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    
    const branches = await octokit.rest.repos.listBranches({
      owner,
      repo,
      per_page: 100
    });
    
    res.json({
      success: true,
      branches: branches.data.map(b => ({
        name: b.name,
        commit: b.commit.sha,
        protected: b.protected
      }))
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint for recent repositories
app.get('/api/recent', (req, res) => {
  res.json({
    success: true,
    recentRepos
  });
});

// Main web interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>GitHub File Browser with History</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          padding: 20px;
        }
        
        .container {
          max-width: 1400px;
          margin: 0 auto;
          background: white;
          border-radius: 12px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          overflow: hidden;
        }
        
        .header {
          background: linear-gradient(135deg, #24292e 0%, #1a1e22 100%);
          color: white;
          padding: 30px;
        }
        
        .header h1 {
          font-size: 28px;
          margin-bottom: 10px;
        }
        
        .header p {
          opacity: 0.8;
        }
        
        .token-status {
          background: rgba(255,255,255,0.1);
          padding: 10px;
          border-radius: 6px;
          margin-top: 15px;
          font-size: 14px;
        }
        
        .token-status.success {
          border-left: 4px solid #28a745;
        }
        
        .token-status.warning {
          border-left: 4px solid #ffc107;
        }
        
        .main-content {
          display: flex;
          height: calc(100vh - 250px);
          min-height: 600px;
        }
        
        .sidebar {
          width: 300px;
          background: #f6f8fa;
          border-right: 1px solid #e1e4e8;
          overflow-y: auto;
          padding: 20px;
        }
        
        .browser {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        
        .toolbar {
          padding: 20px;
          background: white;
          border-bottom: 1px solid #e1e4e8;
        }
        
        .repo-input {
          display: flex;
          gap: 10px;
          margin-bottom: 15px;
        }
        
        .repo-input input {
          flex: 1;
          padding: 10px;
          border: 2px solid #e1e4e8;
          border-radius: 6px;
          font-size: 14px;
        }
        
        .repo-input button {
          padding: 10px 20px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 600;
        }
        
        .branch-selector {
          display: flex;
          gap: 10px;
          align-items: center;
        }
        
        .branch-selector select {
          flex: 1;
          padding: 8px;
          border: 1px solid #e1e4e8;
          border-radius: 4px;
        }
        
        .breadcrumb {
          padding: 15px 20px;
          background: #f6f8fa;
          border-bottom: 1px solid #e1e4e8;
          font-size: 14px;
        }
        
        .breadcrumb a {
          color: #0366d6;
          text-decoration: none;
          cursor: pointer;
        }
        
        .breadcrumb a:hover {
          text-decoration: underline;
        }
        
        .file-list {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
        }
        
        .file-item {
          display: flex;
          align-items: center;
          padding: 12px;
          border-bottom: 1px solid #e1e4e8;
          cursor: pointer;
          transition: background 0.2s;
        }
        
        .file-item:hover {
          background: #f6f8fa;
        }
        
        .file-icon {
          width: 24px;
          margin-right: 12px;
          font-size: 18px;
        }
        
        .file-name {
          flex: 1;
          font-size: 14px;
        }
        
        .file-size {
          color: #586069;
          font-size: 12px;
        }
        
        .content-viewer {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
          background: #f6f8fa;
        }
        
        .history-panel {
          width: 350px;
          background: white;
          border-left: 1px solid #e1e4e8;
          overflow-y: auto;
          padding: 20px;
        }
        
        .commit-item {
          padding: 12px;
          border-bottom: 1px solid #e1e4e8;
          cursor: pointer;
          transition: background 0.2s;
        }
        
        .commit-item:hover {
          background: #f6f8fa;
        }
        
        .commit-sha {
          font-family: monospace;
          font-size: 12px;
          color: #0366d6;
          font-weight: 600;
        }
        
        .commit-message {
          font-size: 13px;
          margin: 5px 0;
        }
        
        .commit-meta {
          font-size: 11px;
          color: #586069;
        }
        
        pre {
          background: white;
          padding: 15px;
          border-radius: 6px;
          overflow-x: auto;
          font-size: 13px;
          line-height: 1.5;
        }
        
        .loading {
          text-align: center;
          padding: 40px;
          color: #586069;
        }
        
        .error {
          color: #d73a49;
          padding: 20px;
          text-align: center;
        }
        
        .repo-info {
          margin-bottom: 20px;
          padding-bottom: 20px;
          border-bottom: 1px solid #e1e4e8;
        }
        
        .repo-name {
          font-weight: 600;
          margin-bottom: 5px;
        }
        
        .repo-stats {
          font-size: 12px;
          color: #586069;
        }
        
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        .spinner {
          border: 3px solid #f3f3f3;
          border-top: 3px solid #667eea;
          border-radius: 50%;
          width: 40px;
          height: 40px;
          animation: spin 1s linear infinite;
          margin: 20px auto;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>📁 GitHub File Browser with History</h1>
          <p>Browse repositories, view file history, and load any file version</p>
          <div id="tokenStatus" class="token-status"></div>
        </div>
        
        <div class="main-content">
          <div class="sidebar">
            <div class="repo-info">
              <strong>📌 Recent Repositories</strong>
            </div>
            <div id="recentList"></div>
          </div>
          
          <div class="browser">
            <div class="toolbar">
              <div class="repo-input">
                <input type="text" id="repoInput" placeholder="owner/repository (e.g., facebook/react)" />
                <button onclick="loadRepository()">Browse</button>
              </div>
              <div class="branch-selector">
                <select id="branchSelect" onchange="changeBranch()">
                  <option value="main">main</option>
                  <option value="master">master</option>
                </select>
                <span id="rateLimit" style="font-size: 12px; color: #586069;"></span>
              </div>
            </div>
            
            <div class="breadcrumb" id="breadcrumb"></div>
            
            <div class="file-list" id="fileList">
              <div class="loading">Enter a repository to start browsing...</div>
            </div>
            
            <div class="content-viewer" id="contentViewer" style="display: none;">
              <div id="fileContent"></div>
            </div>
          </div>
          
          <div class="history-panel" id="historyPanel" style="display: none;">
            <h3>📜 File History</h3>
            <div id="commitHistory"></div>
          </div>
        </div>
      </div>
      
      <script>
        let currentOwner = '';
        let currentRepo = '';
        let currentBranch = 'main';
        let currentPath = '';
        let currentFilePath = '';
        
        // Load token status and rate limit
        async function loadTokenStatus() {
          try {
            const response = await fetch('/api/rate-limit');
            const data = await response.json();
            
            const statusDiv = document.getElementById('tokenStatus');
            if (data.authenticated) {
              const remaining = data.rate.remaining;
              const limit = data.rate.limit;
              statusDiv.className = 'token-status success';
              statusDiv.innerHTML = \`✅ GitHub Token Active | Rate Limit: \${remaining}/\${limit} requests remaining\`;
              document.getElementById('rateLimit').innerHTML = \`📊 \${remaining} requests left\`;
            } else {
              statusDiv.className = 'token-status warning';
              statusDiv.innerHTML = \`⚠️ No GitHub Token | Limited to 60 requests/hour | <a href="#" onclick="showTokenInstructions()" style="color: white;">Click here to add token</a>\`;
              document.getElementById('rateLimit').innerHTML = \`⚠️ 60 requests/hour limit\`;
            }
          } catch (error) {
            console.error('Error loading token status:', error);
          }
        }
        
        function showTokenInstructions() {
          alert(\`To add GitHub token:
          
          1. Get a token from: https://github.com/settings/tokens
          2. Create a .env file in the project root with:
             GITHUB_TOKEN=your_token_here
          3. Restart the server
          
          Or set environment variable:
          export GITHUB_TOKEN=your_token_here\`);
        }
        
        // Load recent repositories
        async function loadRecentRepos() {
          try {
            const response = await fetch('/api/recent');
            const data = await response.json();
            const recentDiv = document.getElementById('recentList');
            
            if (data.recentRepos.length === 0) {
              recentDiv.innerHTML = '<div style="font-size: 12px; color: #586069;">No recent repos</div>';
            } else {
              recentDiv.innerHTML = data.recentRepos.map(repo => 
                \`<div style="padding: 8px; cursor: pointer; margin-bottom: 5px; background: white; border-radius: 4px;" onclick="loadSavedRepository('\${repo}')">
                  📁 \${repo}
                </div>\`
              ).join('');
            }
          } catch (error) {
            console.error('Error loading recent repos:', error);
          }
        }
        
        function loadSavedRepository(repo) {
          document.getElementById('repoInput').value = repo;
          loadRepository();
        }
        
        // Load repository contents
        async function loadRepository() {
          const repoInput = document.getElementById('repoInput').value.trim();
          if (!repoInput) {
            alert('Please enter repository name (owner/repo)');
            return;
          }
          
          const [owner, repo] = repoInput.split('/');
          if (!owner || !repo) {
            alert('Please use format: owner/repository');
            return;
          }
          
          currentOwner = owner;
          currentRepo = repo;
          currentPath = '';
          currentBranch = document.getElementById('branchSelect').value;
          
          await browsePath('');
          await loadBranches();
          await loadRecentRepos();
        }
        
        // Browse specific path
        async function browsePath(path) {
          if (!currentOwner || !currentRepo) return;
          
          const fileListDiv = document.getElementById('fileList');
          fileListDiv.innerHTML = '<div class="spinner"></div>';
          
          try {
            const response = await fetch(\`/api/browse/\${currentOwner}/\${currentRepo}?path=\${encodeURIComponent(path)}&branch=\${currentBranch}\`);
            const data = await response.json();
            
            if (data.success) {
              currentPath = path;
              updateBreadcrumb();
              displayFileList(data.items);
              displayRepoInfo(data.repository);
              
              // Hide content and history viewers
              document.getElementById('contentViewer').style.display = 'none';
              document.getElementById('historyPanel').style.display = 'none';
            } else {
              fileListDiv.innerHTML = \`<div class="error">❌ \${data.error}<br>💡 \${data.hint || ''}</div>\`;
            }
          } catch (error) {
            fileListDiv.innerHTML = \`<div class="error">❌ Error: \${error.message}</div>\`;
          }
        }
        
        // Load branches
        async function loadBranches() {
          try {
            const response = await fetch(\`/api/branches/\${currentOwner}/\${currentRepo}\`);
            const data = await response.json();
            
            if (data.success) {
              const branchSelect = document.getElementById('branchSelect');
              const currentValue = branchSelect.value;
              branchSelect.innerHTML = data.branches.map(b => 
                \`<option value="\${b.name}" \${b.name === currentValue ? 'selected' : ''}>\${b.name}</option>\`
              ).join('');
            }
          } catch (error) {
            console.error('Error loading branches:', error);
          }
        }
        
        function changeBranch() {
          currentBranch = document.getElementById('branchSelect').value;
          browsePath(currentPath);
        }
        
        function updateBreadcrumb() {
          const breadcrumbDiv = document.getElementById('breadcrumb');
          const parts = currentPath.split('/').filter(p => p);
          let html = '<a onclick="browsePath(\'\')">🏠 ' + currentOwner + '/' + currentRepo + '</a>';
          
          let cumulativePath = '';
          parts.forEach((part, index) => {
            cumulativePath += (cumulativePath ? '/' : '') + part;
            html += ' / <a onclick="browsePath(\'' + cumulativePath + '\')">' + part + '</a>';
          });
          
          breadcrumbDiv.innerHTML = html;
        }
        
        function displayFileList(items) {
          const fileListDiv = document.getElementById('fileList');
          
          if (items.length === 0) {
            fileListDiv.innerHTML = '<div class="loading">📂 This directory is empty</div>';
            return;
          }
          
          fileListDiv.innerHTML = items.map(item => {
            const icon = item.type === 'dir' ? '📁' : '📄';
            const size = item.type === 'file' ? formatBytes(item.size) : '';
            return \`
              <div class="file-item" onclick="openItem('\${item.type}', '\${item.path}')">
                <div class="file-icon">\${icon}</div>
                <div class="file-name">\${item.name}</div>
                <div class="file-size">\${size}</div>
              </div>
            \`;
          }).join('');
        }
        
        function displayRepoInfo(repo) {
          const sidebar = document.querySelector('.sidebar');
          const existingInfo = document.querySelector('.repo-details');
          if (existingInfo) existingInfo.remove();
          
          const infoDiv = document.createElement('div');
          infoDiv.className = 'repo-details';
          infoDiv.style.marginBottom = '20px';
          infoDiv.style.padding = '15px';
          infoDiv.style.background = 'white';
          infoDiv.style.borderRadius = '6px';
          infoDiv.innerHTML = \`
            <div class="repo-name">⭐ \${repo.name}</div>
            <div class="repo-stats">🌟 \${repo.stars} stars | 🍴 \${repo.forks} forks</div>
            <div class="repo-stats" style="margin-top: 5px;">\${repo.description || 'No description'}</div>
          \`;
          
          sidebar.insertBefore(infoDiv, sidebar.firstChild);
        }
        
        function openItem(type, path) {
          if (type === 'dir') {
            browsePath(path);
          } else {
            loadFile(path);
          }
        }
        
        async function loadFile(filePath) {
          currentFilePath = filePath;
          const contentViewer = document.getElementById('contentViewer');
          const historyPanel = document.getElementById('historyPanel');
          const fileContentDiv = document.getElementById('fileContent');
          const commitHistoryDiv = document.getElementById('commitHistory');
          
          contentViewer.style.display = 'block';
          historyPanel.style.display = 'block';
          fileContentDiv.innerHTML = '<div class="spinner"></div>';
          commitHistoryDiv.innerHTML = '<div class="loading">Loading history...</div>';
          
          try {
            const response = await fetch(\`/api/file/\${currentOwner}/\${currentRepo}/\${filePath}?branch=\${currentBranch}\`);
            const data = await response.json();
            
            if (data.success) {
              // Display file content
              const extension = data.file.extension;
              let contentHtml = '';
              
              if (data.file.isBinary) {
                contentHtml = '<div class="loading">🔒 Binary file - cannot display</div>';
              } else if (['.jpg', '.png', '.gif', '.svg'].includes(extension)) {
                contentHtml = \`<img src="data:image/\${extension.slice(1)};base64,\${btoa(data.file.content)}" style="max-width: 100%;">\`;
              } else {
                contentHtml = \`
                  <div style="margin-bottom: 10px;">
                    <strong>📄 \${data.file.name}</strong>
                    <span style="float: right; font-size: 12px; color: #586069;">\${data.file.lines} lines | \${formatBytes(data.file.size)}</span>
                  </div>
                  <pre>\${escapeHtml(data.file.content)}</pre>
                \`;
              }
              
              fileContentDiv.innerHTML = contentHtml;
              
              // Display commit history
              if (data.history.length === 0) {
                commitHistoryDiv.innerHTML = '<div class="loading">No commit history found</div>';
              } else {
                commitHistoryDiv.innerHTML = data.history.map(commit => \`
                  <div class="commit-item" onclick="loadCommitVersion('\${commit.sha}')">
                    <div class="commit-sha">\${commit.short_sha}</div>
                    <div class="commit-message">\${escapeHtml(commit.message.split('\\n')[0])}</div>
                    <div class="commit-meta">
                      👤 \${commit.author}<br>
                      📅 \${new Date(commit.date).toLocaleDateString()}<br>
                      📊 +\${commit.additions}/-\${commit.deletions}
                    </div>
                  </div>
                \`).join('');
              }
            } else {
              fileContentDiv.innerHTML = \`<div class="error">❌ \${data.error}</div>\`;
              commitHistoryDiv.innerHTML = '';
            }
          } catch (error) {
            fileContentDiv.innerHTML = \`<div class="error">❌ Error: \${error.message}</div>\`;
          }
        }
        
        async function loadCommitVersion(commitSha) {
          if (!currentFilePath) return;
          
          const fileContentDiv = document.getElementById('fileContent');
          fileContentDiv.innerHTML = '<div class="spinner"></div>';
          
          try {
            const response = await fetch(\`/api/file-version/\${currentOwner}/\${currentRepo}/\${currentFilePath}/commit/\${commitSha}\`);
            const data = await response.json();
            
            if (data.success) {
              fileContentDiv.innerHTML = \`
                <div style="margin-bottom: 10px;">
                  <strong>📄 Version from commit \${commitSha.substring(0, 7)}</strong>
                  <button onclick="loadFile(currentFilePath)" style="float: right; padding: 5px 10px; background: #0366d6; color: white; border: none; border-radius: 4px; cursor: pointer;">Back to latest</button>
                </div>
                <pre>\${escapeHtml(data.content)}</pre>
              \`;
            }
          } catch (error) {
            fileContentDiv.innerHTML = \`<div class="error">❌ Error loading version: \${error.message}</div>\`;
          }
        }
        
        function formatBytes(bytes) {
          if (bytes === 0) return '0 Bytes';
          const k = 1024;
          const sizes = ['Bytes', 'KB', 'MB', 'GB'];
          const i = Math.floor(Math.log(bytes) / Math.log(k));
          return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }
        
        function escapeHtml(text) {
          const div = document.createElement('div');
          div.textContent = text;
          return div.innerHTML;
        }
        
        // Initial load
        loadTokenStatus();
        loadRecentRepos();
        
        // Auto-load example on start
        setTimeout(() => {
          if (!currentOwner) {
            document.getElementById('repoInput').value = 'facebook/react';
            loadRepository();
          }
        }, 500);
      </script>
    </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log('\n========================================');
  console.log('🚀 GitHub File Browser Server Started');
  console.log('========================================');
  console.log(`📡 Server running at: http://localhost:${PORT}`);
  console.log('\n🔑 GitHub Token Configuration:');
  
  if (GITHUB_TOKEN) {
    console.log('✅ GitHub Token is ACTIVE');
    console.log(`   Token: ${GITHUB_TOKEN.substring(0, 10)}...${GITHUB_TOKEN.substring(GITHUB_TOKEN.length - 4)}`);
    console.log('   Rate Limit: 5000 requests/hour');
  } else {
    console.log('⚠️  No GitHub Token Found');
    console.log('   Rate Limit: 60 requests/hour');
    console.log('\n📝 To add a GitHub token:');
    console.log('   Option 1: Create .env file with: GITHUB_TOKEN=your_token_here');
    console.log('   Option 2: Set environment variable: export GITHUB_TOKEN=your_token_here');
    console.log('   Option 3: Get token from: https://github.com/settings/tokens');
  }
  
  console.log('\n📖 Usage:');
  console.log('   - Open browser to http://localhost:3000');
  console.log('   - Enter repository (e.g., facebook/react)');
  console.log('   - Browse files and folders');
  console.log('   - Click any file to view content and history');
  console.log('   - Click on commits to view previous versions');
  console.log('\n========================================\n');
});

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});
