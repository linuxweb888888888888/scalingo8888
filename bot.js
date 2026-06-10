// social-network.js - Complete Working Social Network Script

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware - IMPORTANT: Order matters
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-super-secret-session-key-change-this',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI || 'mongodb://localhost:27017/socialnetwork',
    ttl: 14 * 24 * 60 * 60
  }),
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7,
    httpOnly: true,
    secure: false,
    sameSite: 'lax'
  }
}));

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 5000000 } });

// MongoDB Schema Definitions
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  fullName: { type: String, required: true },
  bio: { type: String, default: '' },
  avatar: { type: String, default: '' },
  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now }
});

const PostSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  image: { type: String, default: '' },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Comment' }],
  createdAt: { type: Date, default: Date.now }
});

const CommentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

// Models
const User = mongoose.model('User', UserSchema);
const Post = mongoose.model('Post', PostSchema);
const Comment = mongoose.model('Comment', CommentSchema);

// Authentication Middleware
const authMiddleware = async (req, res, next) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Please login first' });
    }
    
    const user = await User.findById(req.session.userId).select('-password');
    if (!user) {
      req.session.destroy();
      return res.status(401).json({ error: 'User not found' });
    }
    
    req.user = user;
    req.userId = req.session.userId;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
};

// API Routes

// Check auth status
app.get('/api/auth/check', async (req, res) => {
  try {
    if (req.session && req.session.userId) {
      const user = await User.findById(req.session.userId).select('-password');
      if (user) {
        return res.json({ authenticated: true, user });
      }
    }
    res.json({ authenticated: false });
  } catch (error) {
    console.error('Auth check error:', error);
    res.json({ authenticated: false });
  }
});

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, fullName } = req.body;
    
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      username,
      email,
      password: hashedPassword,
      fullName
    });
    
    await user.save();
    
    req.session.userId = user._id;
    req.session.save();
    
    res.status(201).json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        fullName: user.fullName,
        avatar: user.avatar,
        bio: user.bio,
        followers: user.followers.length,
        following: user.following.length
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    req.session.userId = user._id;
    req.session.save();
    
    user.lastActive = new Date();
    await user.save();
    
    res.json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        fullName: user.fullName,
        avatar: user.avatar,
        bio: user.bio,
        followers: user.followers.length,
        following: user.following.length
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// Get current user
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  res.json(req.user);
});

// Feed posts
app.get('/api/feed', authMiddleware, async (req, res) => {
  try {
    const followingIds = [...req.user.following, req.userId];
    
    const posts = await Post.find({ user: { $in: followingIds } })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('user', 'username fullName avatar');
    
    res.json({ posts });
  } catch (error) {
    console.error('Feed error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create post
app.post('/api/posts', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }
    
    const image = req.file ? `/uploads/${req.file.filename}` : '';
    
    const post = new Post({
      user: req.userId,
      content: content.trim(),
      image
    });
    
    await post.save();
    await post.populate('user', 'username fullName avatar');
    
    res.status(201).json(post);
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Like/Unlike post
app.post('/api/posts/:postId/like', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const likeIndex = post.likes.indexOf(req.userId);
    let liked = false;
    
    if (likeIndex === -1) {
      post.likes.push(req.userId);
      liked = true;
    } else {
      post.likes.splice(likeIndex, 1);
    }
    
    await post.save();
    
    res.json({ liked, likesCount: post.likes.length });
  } catch (error) {
    console.error('Like error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add comment
app.post('/api/posts/:postId/comments', authMiddleware, async (req, res) => {
  try {
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment content is required' });
    }
    
    const comment = new Comment({
      user: req.userId,
      post: req.params.postId,
      content: content.trim()
    });
    
    await comment.save();
    
    const post = await Post.findById(req.params.postId);
    post.comments.push(comment._id);
    await post.save();
    
    await comment.populate('user', 'username fullName avatar');
    
    res.status(201).json(comment);
  } catch (error) {
    console.error('Comment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user profile
app.get('/api/users/:userId', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('-password');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const posts = await Post.find({ user: user._id })
      .sort({ createdAt: -1 })
      .populate('user', 'username fullName avatar');
    
    const isFollowing = user.followers.includes(req.userId);
    const isOwnProfile = req.userId === user._id.toString();
    
    res.json({
      user,
      posts,
      isFollowing,
      isOwnProfile,
      postsCount: posts.length,
      followersCount: user.followers.length,
      followingCount: user.following.length
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Follow/Unfollow user
app.post('/api/users/:userId/follow', authMiddleware, async (req, res) => {
  try {
    const userToFollow = await User.findById(req.params.userId);
    if (!userToFollow) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (req.userId === req.params.userId) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }
    
    const isFollowing = userToFollow.followers.includes(req.userId);
    
    if (isFollowing) {
      // Unfollow
      await User.findByIdAndUpdate(req.userId, { $pull: { following: req.params.userId } });
      await User.findByIdAndUpdate(req.params.userId, { $pull: { followers: req.userId } });
      res.json({ following: false, message: 'Unfollowed' });
    } else {
      // Follow
      await User.findByIdAndUpdate(req.userId, { $addToSet: { following: req.params.userId } });
      await User.findByIdAndUpdate(req.params.userId, { $addToSet: { followers: req.userId } });
      res.json({ following: true, message: 'Followed' });
    }
  } catch (error) {
    console.error('Follow error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Explore - get trending posts and suggested users
app.get('/api/explore', authMiddleware, async (req, res) => {
  try {
    const trendingPosts = await Post.find()
      .sort({ likes: -1, createdAt: -1 })
      .limit(20)
      .populate('user', 'username fullName avatar');
    
    const suggestedUsers = await User.find({
      _id: { $ne: req.userId },
      followers: { $nin: [req.userId] }
    })
      .limit(10)
      .select('username fullName avatar bio');
    
    res.json({ trendingPosts, suggestedUsers });
  } catch (error) {
    console.error('Explore error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Search users and posts
app.get('/api/search', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.trim() === '') {
      return res.json({ users: [], posts: [] });
    }
    
    const searchRegex = new RegExp(q, 'i');
    
    const users = await User.find({
      $or: [
        { username: searchRegex },
        { fullName: searchRegex }
      ],
      _id: { $ne: req.userId }
    })
      .select('username fullName avatar bio')
      .limit(10);
    
    const posts = await Post.find({ content: searchRegex })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('user', 'username fullName avatar');
    
    res.json({ users, posts });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update profile
app.put('/api/users/profile', authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    const { fullName, bio } = req.body;
    const updateData = {};
    
    if (fullName) updateData.fullName = fullName;
    if (bio !== undefined) updateData.bio = bio;
    if (req.file) updateData.avatar = `/uploads/${req.file.filename}`;
    
    const user = await User.findByIdAndUpdate(
      req.userId,
      updateData,
      { new: true }
    ).select('-password');
    
    res.json(user);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Serve HTML
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create uploads directory
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads', { recursive: true });

// Create public directory and HTML file
const publicDir = './public';
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Social Network</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .auth-container { max-width: 400px; margin: 50px auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; font-weight: bold; color: #333; }
        input, textarea { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 5px; font-size: 14px; }
        input:focus, textarea:focus { outline: none; border-color: #667eea; }
        button { background: #667eea; color: white; padding: 12px 20px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; transition: transform 0.2s; }
        button:hover { background: #5a67d8; transform: translateY(-1px); }
        button:disabled { opacity: 0.6; cursor: not-allowed; }
        .error { color: #e53e3e; margin-top: 10px; font-size: 14px; text-align: center; }
        .success { color: #38a169; margin-top: 10px; }
        .hidden { display: none; }
        .navbar { background: white; padding: 15px 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; }
        .nav-links { display: flex; gap: 25px; }
        .nav-links a { text-decoration: none; color: #4a5568; cursor: pointer; font-weight: 500; }
        .nav-links a:hover { color: #667eea; }
        .logo { font-size: 24px; font-weight: bold; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; cursor: pointer; }
        .create-post { background: white; border-radius: 10px; padding: 25px; margin-bottom: 25px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .feed { display: grid; gap: 25px; }
        .post { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .post-header { display: flex; align-items: center; margin-bottom: 15px; cursor: pointer; }
        .avatar { width: 50px; height: 50px; border-radius: 50%; margin-right: 15px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 18px; }
        .post-content { margin-bottom: 15px; line-height: 1.6; color: #2d3748; }
        .post-image { max-width: 100%; border-radius: 8px; margin-top: 10px; }
        .post-actions { display: flex; gap: 15px; margin-top: 15px; padding-top: 15px; border-top: 1px solid #e2e8f0; }
        .post-actions button { width: auto; padding: 8px 20px; background: #f7fafc; color: #4a5568; }
        .post-actions button:hover { background: #edf2f7; transform: none; }
        .loading { text-align: center; padding: 40px; color: white; font-size: 18px; }
        h2, h3 { margin-bottom: 20px; color: #2d3748; }
        textarea { resize: vertical; font-family: inherit; }
        .suggested-users { background: white; border-radius: 10px; padding: 20px; margin-top: 20px; }
        .user-card { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
        .user-info { display: flex; align-items: center; gap: 10px; cursor: pointer; flex: 1; }
        .small-avatar { width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; }
        .friend-button { width: auto; padding: 5px 15px; font-size: 12px; background: #48bb78; }
        .friend-button:hover { background: #38a169; }
        .profile-header { background: white; border-radius: 10px; overflow: hidden; margin-bottom: 25px; }
        .profile-cover { height: 150px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .profile-info { padding: 20px; text-align: center; margin-top: -50px; }
        .profile-avatar { width: 100px; height: 100px; border-radius: 50%; border: 4px solid white; margin: 0 auto 15px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-size: 36px; font-weight: bold; }
        .profile-stats { display: flex; justify-content: center; gap: 30px; margin: 20px 0; }
        .stat { text-align: center; }
        .stat-value { font-size: 24px; font-weight: bold; color: #2d3748; }
        .stat-label { color: #718096; font-size: 14px; }
        .back-button { background: #e2e8f0; color: #4a5568; width: auto; padding: 8px 16px; margin-bottom: 20px; }
        .back-button:hover { background: #cbd5e0; transform: none; }
        @media (max-width: 768px) {
            .container { padding: 10px; }
            .navbar { padding: 10px 15px; }
            .nav-links { gap: 15px; font-size: 14px; }
            .logo { font-size: 18px; }
        }
    </style>
</head>
<body>
    <div id="app">
        <!-- Auth Container -->
        <div class="container" id="authContainer">
            <div class="auth-container">
                <h2 id="authTitle" style="text-align: center; margin-bottom: 25px;">Login</h2>
                <div id="authForm">
                    <div class="form-group">
                        <label>Email</label>
                        <input type="email" id="email" placeholder="Enter your email">
                    </div>
                    <div class="form-group">
                        <label>Password</label>
                        <input type="password" id="password" placeholder="Enter your password">
                    </div>
                    <div id="registerFields" class="hidden">
                        <div class="form-group">
                            <label>Username</label>
                            <input type="text" id="username" placeholder="Choose a username">
                        </div>
                        <div class="form-group">
                            <label>Full Name</label>
                            <input type="text" id="fullName" placeholder="Your full name">
                        </div>
                    </div>
                    <button onclick="handleAuth()" id="authButton">Login</button>
                    <p style="margin-top: 20px; text-align: center;">
                        <a href="#" onclick="toggleAuth()" id="toggleLink" style="color: #667eea; text-decoration: none;">Don't have an account? Register</a>
                    </p>
                    <div id="authMessage" class="error"></div>
                </div>
            </div>
        </div>
        
        <!-- Main App Container -->
        <div id="mainApp" class="hidden">
            <div class="navbar">
                <div class="logo" onclick="showFeed()">SocialNetwork</div>
                <div class="nav-links">
                    <a onclick="showFeed()">🏠 Feed</a>
                    <a onclick="showExplore()">✨ Explore</a>
                    <a onclick="showMyProfile()">👤 Profile</a>
                    <a onclick="logout()">🚪 Logout</a>
                </div>
            </div>
            <div class="container" id="mainContent">
                <div class="loading">Loading...</div>
            </div>
        </div>
    </div>
    
    <script>
        let currentUser = null;
        let currentView = 'feed';
        
        // Fetch with credentials
        async function fetchWithCredentials(url, options = {}) {
            const response = await fetch(url, {
                ...options,
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });
            return response;
        }
        
        // Check authentication
        window.onload = async function() {
            await checkAuth();
        };
        
        async function checkAuth() {
            try {
                const response = await fetchWithCredentials('/api/auth/check');
                const data = await response.json();
                
                if (data.authenticated) {
                    currentUser = data.user;
                    showMainApp();
                    showFeed();
                } else {
                    showAuth();
                }
            } catch (error) {
                console.error('Auth check error:', error);
                showAuth();
            }
        }
        
        function showAuth() {
            document.getElementById('authContainer').classList.remove('hidden');
            document.getElementById('mainApp').classList.add('hidden');
        }
        
        function showMainApp() {
            document.getElementById('authContainer').classList.add('hidden');
            document.getElementById('mainApp').classList.remove('hidden');
        }
        
        let isLoginMode = true;
        
        function toggleAuth() {
            isLoginMode = !isLoginMode;
            if (isLoginMode) {
                document.getElementById('authTitle').innerText = 'Login';
                document.getElementById('authButton').innerText = 'Login';
                document.getElementById('toggleLink').innerHTML = "Don't have an account? Register";
                document.getElementById('registerFields').classList.add('hidden');
            } else {
                document.getElementById('authTitle').innerText = 'Register';
                document.getElementById('authButton').innerText = 'Register';
                document.getElementById('toggleLink').innerHTML = 'Already have an account? Login';
                document.getElementById('registerFields').classList.remove('hidden');
            }
            document.getElementById('authMessage').innerText = '';
        }
        
        async function handleAuth() {
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            
            if (!email || !password) {
                document.getElementById('authMessage').innerText = 'Please fill in all fields';
                return;
            }
            
            const button = document.getElementById('authButton');
            button.disabled = true;
            button.innerText = 'Processing...';
            
            try {
                let response;
                if (isLoginMode) {
                    response = await fetchWithCredentials('/api/auth/login', {
                        method: 'POST',
                        body: JSON.stringify({ email, password })
                    });
                } else {
                    const username = document.getElementById('username').value;
                    const fullName = document.getElementById('fullName').value;
                    
                    if (!username || !fullName) {
                        document.getElementById('authMessage').innerText = 'Please fill in all fields';
                        button.disabled = false;
                        button.innerText = isLoginMode ? 'Login' : 'Register';
                        return;
                    }
                    
                    response = await fetchWithCredentials('/api/auth/register', {
                        method: 'POST',
                        body: JSON.stringify({ email, password, username, fullName })
                    });
                }
                
                const data = await response.json();
                
                if (response.ok) {
                    currentUser = data.user;
                    showMainApp();
                    showFeed();
                    document.getElementById('email').value = '';
                    document.getElementById('password').value = '';
                    if (!isLoginMode) {
                        document.getElementById('username').value = '';
                        document.getElementById('fullName').value = '';
                    }
                } else {
                    document.getElementById('authMessage').innerText = data.error || 'Authentication failed';
                }
            } catch (error) {
                console.error('Auth error:', error);
                document.getElementById('authMessage').innerText = 'Network error. Please try again.';
            } finally {
                button.disabled = false;
                button.innerText = isLoginMode ? 'Login' : 'Register';
            }
        }
        
        async function showFeed() {
            currentView = 'feed';
            const contentDiv = document.getElementById('mainContent');
            contentDiv.innerHTML = \`
                <div class="create-post">
                    <h3>Create Post</h3>
                    <textarea id="postContent" rows="3" placeholder="What's on your mind?"></textarea>
                    <input type="file" id="postImage" accept="image/*" style="margin-top: 10px;">
                    <button onclick="createPost()" style="margin-top: 15px;">📝 Post</button>
                </div>
                <div id="feedContainer">
                    <div class="loading">Loading posts...</div>
                </div>
            \`;
            await loadFeed();
        }
        
        async function loadFeed() {
            const feedContainer = document.getElementById('feedContainer');
            if (!feedContainer) return;
            
            feedContainer.innerHTML = '<div class="loading">Loading posts...</div>';
            
            try {
                const response = await fetchWithCredentials('/api/feed');
                
                if (!response.ok) {
                    throw new Error('Failed to load feed');
                }
                
                const data = await response.json();
                displayPosts(data.posts, feedContainer);
            } catch (error) {
                console.error('Error loading feed:', error);
                feedContainer.innerHTML = '<div class="loading">Error loading feed. Please <a href="#" onclick="location.reload()">refresh</a>.</div>';
            }
        }
        
        async function showExplore() {
            currentView = 'explore';
            const contentDiv = document.getElementById('mainContent');
            contentDiv.innerHTML = '<div class="loading">Loading explore...</div>';
            
            try {
                const response = await fetchWithCredentials('/api/explore');
                
                if (!response.ok) throw new Error('Failed to load explore');
                
                const data = await response.json();
                
                let html = '<h2>🔥 Trending Posts</h2>';
                const tempDiv = document.createElement('div');
                displayPosts(data.trendingPosts, tempDiv);
                html += tempDiv.innerHTML;
                
                if (data.suggestedUsers && data.suggestedUsers.length > 0) {
                    html += '<div class="suggested-users"><h3>👥 Suggested Users</h3>';
                    for (const user of data.suggestedUsers) {
                        html += \`
                            <div class="user-card">
                                <div class="user-info" onclick="viewProfile('\${user._id}')">
                                    <div class="small-avatar">\${(user.fullName || user.username).charAt(0).toUpperCase()}</div>
                                    <div>
                                        <strong>\${escapeHtml(user.fullName || user.username)}</strong><br>
                                        <small style="color: #718096;">@\${escapeHtml(user.username)}</small>
                                    </div>
                                </div>
                                <button class="friend-button" onclick="event.stopPropagation(); followUser('\${user._id}', this)">Follow</button>
                            </div>
                        \`;
                    }
                    html += '</div>';
                }
                
                contentDiv.innerHTML = html;
            } catch (error) {
                console.error('Error loading explore:', error);
                contentDiv.innerHTML = '<div class="loading">Error loading explore. Please try again.</div>';
            }
        }
        
        function displayPosts(posts, container) {
            if (!posts || posts.length === 0) {
                container.innerHTML = '<p style="text-align: center; color: #718096;">No posts yet. Be the first to post!</p>';
                return;
            }
            
            let html = '<div class="feed">';
            for (const post of posts) {
                const user = post.user || {};
                html += \`
                    <div class="post">
                        <div class="post-header" onclick="viewProfile('\${user._id}')">
                            <div class="avatar">\${(user.fullName || 'U').charAt(0).toUpperCase()}</div>
                            <div>
                                <strong>\${escapeHtml(user.fullName || 'Unknown')}</strong><br>
                                <small style="color: #718096;">@\${escapeHtml(user.username || 'user')}</small>
                            </div>
                        </div>
                        <div class="post-content">\${escapeHtml(post.content)}</div>
                        \${post.image ? \`<img src="\${post.image}" class="post-image" alt="Post image">\` : ''}
                        <div class="post-actions">
                            <button onclick="event.stopPropagation(); likePost('\${post._id}', this)">❤️ \${post.likes?.length || 0}</button>
                            <button onclick="event.stopPropagation(); commentOnPost('\${post._id}')">💬 \${post.comments?.length || 0}</button>
                        </div>
                    </div>
                \`;
            }
            html += '</div>';
            container.innerHTML = html;
        }
        
        async function showMyProfile() {
            if (currentUser) {
                await viewProfile(currentUser.id);
            }
        }
        
        async function viewProfile(userId) {
            currentView = 'profile';
            const contentDiv = document.getElementById('mainContent');
            contentDiv.innerHTML = '<div class="loading">Loading profile...</div>';
            
            try {
                const response = await fetchWithCredentials(\`/api/users/\${userId}\`);
                
                if (!response.ok) throw new Error('Failed to load profile');
                
                const data = await response.json();
                
                let html = \`
                    <button class="back-button" onclick="showFeed()">← Back to Feed</button>
                    <div class="profile-header">
                        <div class="profile-cover"></div>
                        <div class="profile-info">
                            <div class="profile-avatar">\${(data.user.fullName || data.user.username).charAt(0).toUpperCase()}</div>
                            <h2>\${escapeHtml(data.user.fullName)}</h2>
                            <p style="color: #718096;">@\${escapeHtml(data.user.username)}</p>
                            \${data.user.bio ? \`<p style="margin-top: 10px;">\${escapeHtml(data.user.bio)}</p>\` : ''}
                            <div class="profile-stats">
                                <div class="stat">
                                    <div class="stat-value">\${data.postsCount}</div>
                                    <div class="stat-label">Posts</div>
                                </div>
                                <div class="stat">
                                    <div class="stat-value">\${data.followersCount}</div>
                                    <div class="stat-label">Followers</div>
                                </div>
                                <div class="stat">
                                    <div class="stat-value">\${data.followingCount}</div>
                                    <div class="stat-label">Following</div>
                                </div>
                            </div>
                            \${!data.isOwnProfile ? \`
                                <button onclick="followUser('\${data.user._id}', this)" class="friend-button" style="width: auto; margin-top: 10px;">
                                    \${data.isFollowing ? 'Unfollow' : 'Follow'}
                                </button>
                            \` : \`
                                <button onclick="editProfile()" class="friend-button" style="width: auto; margin-top: 10px; background: #667eea;">
                                    Edit Profile
                                </button>
                            \`}
                        </div>
                    </div>
                    <h3>Posts</h3>
                    <div id="profilePosts"></div>
                \`;
                
                contentDiv.innerHTML = html;
                
                const postsContainer = document.getElementById('profilePosts');
                displayPosts(data.posts, postsContainer);
            } catch (error) {
                console.error('Error loading profile:', error);
                contentDiv.innerHTML = '<div class="loading">Error loading profile. Please try again.</div>';
            }
        }
        
        function editProfile() {
            const newBio = prompt('Enter your bio:', currentUser?.bio || '');
            if (newBio !== null) {
                updateProfile({ bio: newBio });
            }
        }
        
        async function updateProfile(updates) {
            try {
                const response = await fetchWithCredentials('/api/users/profile', {
                    method: 'PUT',
                    body: JSON.stringify(updates)
                });
                
                if (response.ok) {
                    const updatedUser = await response.json();
                    currentUser = updatedUser;
                    await viewProfile(currentUser.id);
                } else {
                    alert('Failed to update profile');
                }
            } catch (error) {
                console.error('Update profile error:', error);
                alert('Error updating profile');
            }
        }
        
        async function createPost() {
            const content = document.getElementById('postContent')?.value;
            if (!content?.trim()) {
                alert('Please enter some content');
                return;
            }
            
            const imageFile = document.getElementById('postImage')?.files[0];
            const formData = new FormData();
            formData.append('content', content);
            if (imageFile) formData.append('image', imageFile);
            
            const button = event.target;
            button.disabled = true;
            button.innerText = 'Posting...';
            
            try {
                const response = await fetch('/api/posts', {
                    method: 'POST',
                    body: formData,
                    credentials: 'include'
                });
                
                if (response.ok) {
                    const postInput = document.getElementById('postContent');
                    const imageInput = document.getElementById('postImage');
                    if (postInput) postInput.value = '';
                    if (imageInput) imageInput.value = '';
                    await loadFeed();
                } else {
                    const error = await response.json();
                    alert(error.error || 'Failed to create post');
                }
            } catch (error) {
                console.error('Error creating post:', error);
                alert('Error creating post. Please try again.');
            } finally {
                button.disabled = false;
                button.innerText = '📝 Post';
            }
        }
        
        async function likePost(postId, button) {
            try {
                const response = await fetchWithCredentials(\`/api/posts/\${postId}/like\`, {
                    method: 'POST'
                });
                
                if (response.ok) {
                    if (currentView === 'feed') {
                        await loadFeed();
                    } else if (currentView === 'explore') {
                        await showExplore();
                    } else if (currentView === 'profile') {
                        await viewProfile(currentUser.id);
                    }
                }
            } catch (error) {
                console.error('Error liking post:', error);
            }
        }
        
        async function commentOnPost(postId) {
            const comment = prompt('Enter your comment:');
            if (comment && comment.trim()) {
                try {
                    const response = await fetchWithCredentials(\`/api/posts/\${postId}/comments\`, {
                        method: 'POST',
                        body: JSON.stringify({ content: comment })
                    });
                    
                    if (response.ok) {
                        if (currentView === 'feed') {
                            await loadFeed();
                        } else if (currentView === 'explore') {
                            await showExplore();
                        } else if (currentView === 'profile') {
                            await viewProfile(currentUser.id);
                        }
                    } else {
                        alert('Failed to add comment');
                    }
                } catch (error) {
                    console.error('Error:', error);
                    alert('Error adding comment');
                }
            }
        }
        
        async function followUser(userId, button) {
            try {
                const response = await fetchWithCredentials(\`/api/users/\${userId}/follow\`, {
                    method: 'POST'
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (button) {
                        button.innerText = data.following ? 'Unfollow' : 'Follow';
                    }
                    if (currentView === 'explore') {
                        await showExplore();
                    } else if (currentView === 'profile') {
                        await viewProfile(userId);
                    }
                } else {
                    const error = await response.json();
                    alert(error.error || 'Failed to follow user');
                }
            } catch (error) {
                console.error('Error:', error);
                alert('Error following user');
            }
        }
        
        function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        async function logout() {
            try {
                await fetchWithCredentials('/api/auth/logout', { method: 'POST' });
                currentUser = null;
                showAuth();
            } catch (error) {
                console.error('Logout error:', error);
                showAuth();
            }
        }
    </script>
</body>
</html>`;

fs.writeFileSync(path.join(publicDir, 'index.html'), htmlContent);

// Database connection and server start
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/socialnetwork';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('✅ Connected to MongoDB');
  app.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📝 Open your browser to http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('❌ MongoDB connection error:', err.message);
  process.exit(1);
});
