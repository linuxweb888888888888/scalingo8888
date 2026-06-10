// social-network.js - Complete Social Network Script for Scalingo
// Deploy on Scalingo: single file with all features

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const socketIo = require('socket.io');
const http = require('http');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
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
  avatar: { type: String, default: 'default-avatar.png' },
  coverPhoto: { type: String, default: '' },
  location: { type: String, default: '' },
  website: { type: String, default: '' },
  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  isPrivate: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now }
});

const PostSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  image: { type: String, default: '' },
  video: { type: String, default: '' },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Comment' }],
  shares: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const CommentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
  content: { type: String, required: true },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  replies: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Comment' }],
  createdAt: { type: Date, default: Date.now }
});

const FriendshipSchema = new mongoose.Schema({
  requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'accepted', 'rejected', 'blocked'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const NotificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['like', 'comment', 'friend_request', 'friend_accept', 'mention', 'share'], required: true },
  from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
  comment: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment' },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, required: true },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

// Models
const User = mongoose.model('User', UserSchema);
const Post = mongoose.model('Post', PostSchema);
const Comment = mongoose.model('Comment', CommentSchema);
const Friendship = mongoose.model('Friendship', FriendshipSchema);
const Notification = mongoose.model('Notification', NotificationSchema);
const Message = mongoose.model('Message', MessageSchema);

// Authentication Middleware
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) throw new Error();
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-this');
    const user = await User.findById(decoded.userId).select('-password');
    
    if (!user) throw new Error();
    
    req.user = user;
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Please authenticate' });
  }
};

// Socket.IO for real-time features
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-this');
    socket.userId = decoded.userId;
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.userId);
  
  socket.join(`user_${socket.userId}`);
  
  socket.on('send_message', async (data) => {
    try {
      const message = new Message({
        sender: socket.userId,
        receiver: data.receiverId,
        message: data.message
      });
      await message.save();
      
      const populatedMessage = await Message.findById(message._id).populate('sender', 'username fullName avatar');
      
      io.to(`user_${data.receiverId}`).emit('receive_message', populatedMessage);
      socket.emit('message_sent', populatedMessage);
    } catch (error) {
      socket.emit('message_error', { error: error.message });
    }
  });
  
  socket.on('typing', (data) => {
    socket.to(`user_${data.receiverId}`).emit('user_typing', { userId: socket.userId, isTyping: data.isTyping });
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.userId);
  });
});

// API Routes

// Auth Routes
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
    
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'your-secret-key-change-this', { expiresIn: '7d' });
    
    res.status(201).json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        fullName: user.fullName,
        avatar: user.avatar
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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
    
    user.lastActive = new Date();
    await user.save();
    
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'your-secret-key-change-this', { expiresIn: '7d' });
    
    res.json({
      token,
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
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  res.json(req.user);
});

// Post Routes
app.get('/api/posts', authMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    
    // Get posts from user and users they follow
    const followingUsers = [...req.user.following, req.user._id];
    
    const posts = await Post.find({ user: { $in: followingUsers } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'username fullName avatar')
      .populate({
        path: 'comments',
        populate: { path: 'user', select: 'username fullName avatar' },
        options: { limit: 3 }
      });
    
    const total = await Post.countDocuments({ user: { $in: followingUsers } });
    
    res.json({
      posts,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      totalPosts: total
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/posts', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    const { content } = req.body;
    const image = req.file ? `/uploads/${req.file.filename}` : '';
    
    const post = new Post({
      user: req.userId,
      content,
      image
    });
    
    await post.save();
    await post.populate('user', 'username fullName avatar');
    
    res.status(201).json(post);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/posts/:postId', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId)
      .populate('user', 'username fullName avatar bio')
      .populate({
        path: 'comments',
        populate: { path: 'user', select: 'username fullName avatar' }
      });
    
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    res.json(post);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/posts/:postId', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.postId, user: req.userId });
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    await Comment.deleteMany({ post: post._id });
    await post.deleteOne();
    
    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Like Routes
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
      
      // Create notification
      if (post.user.toString() !== req.userId) {
        const notification = new Notification({
          user: post.user,
          type: 'like',
          from: req.userId,
          post: post._id
        });
        await notification.save();
        
        // Emit real-time notification
        io.to(`user_${post.user}`).emit('new_notification', {
          type: 'like',
          from: req.user.username,
          postId: post._id
        });
      }
    } else {
      post.likes.splice(likeIndex, 1);
    }
    
    await post.save();
    
    res.json({ liked, likesCount: post.likes.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Comment Routes
app.post('/api/posts/:postId/comments', authMiddleware, async (req, res) => {
  try {
    const { content } = req.body;
    
    const comment = new Comment({
      user: req.userId,
      post: req.params.postId,
      content
    });
    
    await comment.save();
    
    const post = await Post.findById(req.params.postId);
    post.comments.push(comment._id);
    await post.save();
    
    await comment.populate('user', 'username fullName avatar');
    
    // Create notification
    if (post.user.toString() !== req.userId) {
      const notification = new Notification({
        user: post.user,
        type: 'comment',
        from: req.userId,
        post: post._id,
        comment: comment._id
      });
      await notification.save();
      
      io.to(`user_${post.user}`).emit('new_notification', {
        type: 'comment',
        from: req.user.username,
        postId: post._id
      });
    }
    
    res.status(201).json(comment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// User Routes
app.get('/api/users/:userId', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId)
      .select('-password')
      .populate('followers', 'username fullName avatar')
      .populate('following', 'username fullName avatar');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const isFollowing = user.followers.some(f => f._id.toString() === req.userId);
    const isFollower = user.following.some(f => f._id.toString() === req.userId);
    
    res.json({
      ...user.toObject(),
      isFollowing,
      isFollower,
      postsCount: await Post.countDocuments({ user: user._id }),
      followersCount: user.followers.length,
      followingCount: user.following.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/users/profile', authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    const { fullName, bio, location, website } = req.body;
    const updateData = { fullName, bio, location, website };
    
    if (req.file) {
      updateData.avatar = `/uploads/${req.file.filename}`;
    }
    
    const user = await User.findByIdAndUpdate(
      req.userId,
      updateData,
      { new: true }
    ).select('-password');
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Friend Routes
app.post('/api/friends/request/:userId', authMiddleware, async (req, res) => {
  try {
    const recipientId = req.params.userId;
    
    if (recipientId === req.userId) {
      return res.status(400).json({ error: 'Cannot send friend request to yourself' });
    }
    
    const existingFriendship = await Friendship.findOne({
      $or: [
        { requester: req.userId, recipient: recipientId },
        { requester: recipientId, recipient: req.userId }
      ]
    });
    
    if (existingFriendship) {
      return res.status(400).json({ error: 'Friend request already exists' });
    }
    
    const friendship = new Friendship({
      requester: req.userId,
      recipient: recipientId
    });
    
    await friendship.save();
    
    // Create notification
    const notification = new Notification({
      user: recipientId,
      type: 'friend_request',
      from: req.userId
    });
    await notification.save();
    
    io.to(`user_${recipientId}`).emit('new_notification', {
      type: 'friend_request',
      from: req.user.username
    });
    
    res.json({ message: 'Friend request sent' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/friends/accept/:requestId', authMiddleware, async (req, res) => {
  try {
    const friendship = await Friendship.findById(req.params.requestId);
    
    if (!friendship || friendship.recipient.toString() !== req.userId) {
      return res.status(404).json({ error: 'Friend request not found' });
    }
    
    friendship.status = 'accepted';
    await friendship.save();
    
    // Add to followers/following
    await User.findByIdAndUpdate(friendship.requester, {
      $addToSet: { following: friendship.recipient, followers: friendship.recipient }
    });
    
    await User.findByIdAndUpdate(friendship.recipient, {
      $addToSet: { following: friendship.requester, followers: friendship.requester }
    });
    
    // Create notification for acceptance
    const notification = new Notification({
      user: friendship.requester,
      type: 'friend_accept',
      from: req.userId
    });
    await notification.save();
    
    io.to(`user_${friendship.requester}`).emit('new_notification', {
      type: 'friend_accept',
      from: req.user.username
    });
    
    res.json({ message: 'Friend request accepted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Notification Routes
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const notifications = await Notification.find({ user: req.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('from', 'username fullName avatar')
      .populate('post', 'content image');
    
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/notifications/:notificationId/read', authMiddleware, async (req, res) => {
  try {
    await Notification.findByIdAndUpdate(req.params.notificationId, { read: true });
    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Message Routes
app.get('/api/messages/:userId', authMiddleware, async (req, res) => {
  try {
    const messages = await Message.find({
      $or: [
        { sender: req.userId, receiver: req.params.userId },
        { sender: req.params.userId, receiver: req.userId }
      ]
    })
      .sort({ createdAt: 1 })
      .populate('sender', 'username fullName avatar')
      .populate('receiver', 'username fullName avatar');
    
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search Routes
app.get('/api/search', authMiddleware, async (req, res) => {
  try {
    const { q, type = 'all' } = req.query;
    
    if (!q) {
      return res.json({ users: [], posts: [] });
    }
    
    const searchRegex = new RegExp(q, 'i');
    let results = {};
    
    if (type === 'all' || type === 'users') {
      results.users = await User.find({
        $or: [
          { username: searchRegex },
          { fullName: searchRegex },
          { email: searchRegex }
        ]
      })
        .select('username fullName avatar bio followers following')
        .limit(20);
    }
    
    if (type === 'all' || type === 'posts') {
      results.posts = await Post.find({ content: searchRegex })
        .sort({ createdAt: -1 })
        .limit(20)
        .populate('user', 'username fullName avatar');
    }
    
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Timeline/Feed Routes
app.get('/api/feed', authMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    
    const followingIds = req.user.following;
    followingIds.push(req.userId);
    
    const posts = await Post.find({ user: { $in: followingIds } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'username fullName avatar')
      .populate({
        path: 'comments',
        options: { limit: 5 },
        populate: { path: 'user', select: 'username fullName avatar' }
      });
    
    const total = await Post.countDocuments({ user: { $in: followingIds } });
    
    res.json({
      posts,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + limit < total
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Explore Routes
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
      .select('username fullName avatar bio followers');
    
    res.json({
      trendingPosts,
      suggestedUsers
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Frontend route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create public directory and index.html
const publicDir = './public';
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Social Network</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .auth-container { max-width: 400px; margin: 50px auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 20px rgba(0,0,0,0.1); }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input, textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; font-size: 14px; }
        button { background: #667eea; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; width: 100%; }
        button:hover { background: #5a67d8; }
        .error { color: red; margin-top: 10px; }
        .success { color: green; margin-top: 10px; }
        .feed { display: grid; gap: 20px; }
        .post { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
        .post-header { display: flex; align-items: center; margin-bottom: 15px; }
        .avatar { width: 50px; height: 50px; border-radius: 50%; margin-right: 15px; background: #667eea; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; }
        .post-content { margin-bottom: 15px; }
        .post-actions { display: flex; gap: 15px; margin-top: 10px; }
        .post-actions button { width: auto; padding: 5px 15px; }
        .hidden { display: none; }
        .navbar { background: white; padding: 15px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); display: flex; justify-content: space-between; align-items: center; }
        .nav-links { display: flex; gap: 20px; }
        .nav-links a { text-decoration: none; color: #333; cursor: pointer; }
        .create-post { background: white; border-radius: 10px; padding: 20px; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div id="app">
        <div class="container" id="authContainer">
            <div class="auth-container">
                <h2 id="authTitle">Login</h2>
                <div id="authForm">
                    <div class="form-group">
                        <label>Email</label>
                        <input type="email" id="email" placeholder="Enter email">
                    </div>
                    <div class="form-group">
                        <label>Password</label>
                        <input type="password" id="password" placeholder="Enter password">
                    </div>
                    <div id="registerFields" class="hidden">
                        <div class="form-group">
                            <label>Username</label>
                            <input type="text" id="username" placeholder="Choose username">
                        </div>
                        <div class="form-group">
                            <label>Full Name</label>
                            <input type="text" id="fullName" placeholder="Your full name">
                        </div>
                    </div>
                    <button onclick="handleAuth()" id="authButton">Login</button>
                    <p style="margin-top: 15px; text-align: center;">
                        <a href="#" onclick="toggleAuth()" id="toggleLink">Don't have an account? Register</a>
                    </p>
                    <div id="authMessage" class="error"></div>
                </div>
            </div>
        </div>
        
        <div id="mainApp" class="hidden">
            <div class="navbar">
                <h2>Social Network</h2>
                <div class="nav-links">
                    <a onclick="loadFeed()">Feed</a>
                    <a onclick="loadExplore()">Explore</a>
                    <a onclick="showProfile()">Profile</a>
                    <a onclick="logout()">Logout</a>
                </div>
            </div>
            <div class="container">
                <div class="create-post">
                    <textarea id="postContent" rows="3" placeholder="What's on your mind?" style="width: 100%;"></textarea>
                    <input type="file" id="postImage" accept="image/*">
                    <button onclick="createPost()" style="margin-top: 10px;">Post</button>
                </div>
                <div id="feed"></div>
            </div>
        </div>
    </div>
    
    <script>
        let token = localStorage.getItem('token');
        let currentUser = null;
        
        if (token) {
            showMainApp();
            loadFeed();
        }
        
        function toggleAuth() {
            const isLogin = document.getElementById('authTitle').innerText === 'Login';
            if (isLogin) {
                document.getElementById('authTitle').innerText = 'Register';
                document.getElementById('authButton').innerText = 'Register';
                document.getElementById('toggleLink').innerHTML = 'Already have an account? Login';
                document.getElementById('registerFields').classList.remove('hidden');
            } else {
                document.getElementById('authTitle').innerText = 'Login';
                document.getElementById('authButton').innerText = 'Login';
                document.getElementById('toggleLink').innerHTML = 'Don\'t have an account? Register';
                document.getElementById('registerFields').classList.add('hidden');
            }
        }
        
        async function handleAuth() {
            const isRegister = document.getElementById('authTitle').innerText === 'Register';
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            
            try {
                let response;
                if (isRegister) {
                    const username = document.getElementById('username').value;
                    const fullName = document.getElementById('fullName').value;
                    response = await fetch('/api/auth/register', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email, password, username, fullName })
                    });
                } else {
                    response = await fetch('/api/auth/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email, password })
                    });
                }
                
                const data = await response.json();
                if (response.ok) {
                    token = data.token;
                    currentUser = data.user;
                    localStorage.setItem('token', token);
                    showMainApp();
                    loadFeed();
                } else {
                    document.getElementById('authMessage').innerText = data.error || 'Authentication failed';
                }
            } catch (error) {
                document.getElementById('authMessage').innerText = 'Network error';
            }
        }
        
        function showMainApp() {
            document.getElementById('authContainer').classList.add('hidden');
            document.getElementById('mainApp').classList.remove('hidden');
        }
        
        async function loadFeed() {
            try {
                const response = await fetch('/api/feed', {
                    headers: { 'Authorization': \`Bearer \${token}\` }
                });
                const data = await response.json();
                displayPosts(data.posts);
            } catch (error) {
                console.error('Error loading feed:', error);
            }
        }
        
        async function loadExplore() {
            try {
                const response = await fetch('/api/explore', {
                    headers: { 'Authorization': \`Bearer \${token}\` }
                });
                const data = await response.json();
                displayPosts(data.trendingPosts);
            } catch (error) {
                console.error('Error loading explore:', error);
            }
        }
        
        function displayPosts(posts) {
            const feedDiv = document.getElementById('feed');
            if (!posts || posts.length === 0) {
                feedDiv.innerHTML = '<p>No posts yet. Be the first to post!</p>';
                return;
            }
            
            feedDiv.innerHTML = posts.map(post => \`
                <div class="post">
                    <div class="post-header">
                        <div class="avatar">\${post.user?.fullName?.charAt(0) || 'U'}</div>
                        <div>
                            <strong>\${post.user?.fullName || 'Unknown'}</strong><br>
                            <small>@\${post.user?.username || 'user'}</small>
                        </div>
                    </div>
                    <div class="post-content">\${post.content}</div>
                    \${post.image ? \`<img src="\${post.image}" style="max-width: 100%; border-radius: 5px; margin-top: 10px;">\` : ''}
                    <div class="post-actions">
                        <button onclick="likePost('\${post._id}')">❤️ \${post.likes?.length || 0}</button>
                        <button onclick="commentOnPost('\${post._id}')">💬 \${post.comments?.length || 0}</button>
                    </div>
                </div>
            \`).join('');
        }
        
        async function createPost() {
            const content = document.getElementById('postContent').value;
            const imageFile = document.getElementById('postImage').files[0];
            
            const formData = new FormData();
            formData.append('content', content);
            if (imageFile) formData.append('image', imageFile);
            
            try {
                const response = await fetch('/api/posts', {
                    method: 'POST',
                    headers: { 'Authorization': \`Bearer \${token}\` },
                    body: formData
                });
                
                if (response.ok) {
                    document.getElementById('postContent').value = '';
                    document.getElementById('postImage').value = '';
                    loadFeed();
                }
            } catch (error) {
                console.error('Error creating post:', error);
            }
        }
        
        async function likePost(postId) {
            try {
                await fetch(\`/api/posts/\${postId}/like\`, {
                    method: 'POST',
                    headers: { 'Authorization': \`Bearer \${token}\` }
                });
                loadFeed();
            } catch (error) {
                console.error('Error liking post:', error);
            }
        }
        
        function commentOnPost(postId) {
            const comment = prompt('Enter your comment:');
            if (comment) {
                fetch(\`/api/posts/\${postId}/comments\`, {
                    method: 'POST',
                    headers: {
                        'Authorization': \`Bearer \${token}\`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ content: comment })
                }).then(() => loadFeed());
            }
        }
        
        function showProfile() {
            window.location.href = '/profile.html';
        }
        
        function logout() {
            localStorage.removeItem('token');
            window.location.reload();
        }
    </script>
</body>
</html>
`;

fs.writeFileSync(path.join(publicDir, 'index.html'), htmlContent);

// Create uploads directory if not exists
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// Database connection and server start
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/socialnetwork';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('Connected to MongoDB');
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

// Error handling
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});
