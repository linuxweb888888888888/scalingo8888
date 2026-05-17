// stratum-relay.js - Single file Stratum relay for Scalingo.com
//
const net = require('net');
const http = require('http');

// ============= CONFIGURATION (Configured for your pool) =============
const CONFIG = {
  // Relay port (Scalingo will set PORT env var, but we'll use this as fallback)
  PORT: process.env.PORT || 3000,
  
  // Upstream pool configuration (YOUR POOL)
  UPSTREAM_HOST: '192.95.37.3',
  UPSTREAM_PORT: 17149,
  
  // Connection settings
  MAX_CONNECTIONS: 1000,
  CONNECTION_TIMEOUT: 30000, // milliseconds
  
  // Mining settings
  DIFFICULTY_FACTOR: 1.0,    // Adjust difficulty (1.0 = no change)
  
  // Logging
  LOG_LEVEL: 'info',         // 'debug', 'info', 'warn', 'error'
  
  // Health check
  HEALTH_PORT: 3001,
  
  // Custom subscription message (if needed)
  CUSTOM_SUBSCRIBE: null     // Set to null for default, or provide custom JSON
};

// ============= LOGGER =============
const logger = {
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
  error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`),
  debug: (msg) => CONFIG.LOG_LEVEL === 'debug' && console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`)
};

// ============= RELAY STATE =============
let connectionCount = 0;
let totalConnectionsHandled = 0;
const upstreamConnections = new Map(); // client -> upstream
const clientBuffers = new Map(); // client -> buffer
const upstreamBuffers = new Map(); // upstream -> buffer

// ============= STRATUM MESSAGE HANDLING =============
function processStratumMessage(data, socket, isFromClient) {
  const buffer = isFromClient ? clientBuffers.get(socket) : upstreamBuffers.get(socket);
  const newBuffer = buffer + data.toString();
  
  if (isFromClient) {
    clientBuffers.set(socket, newBuffer);
  } else {
    upstreamBuffers.set(socket, newBuffer);
  }
  
  const currentBuffer = isFromClient ? clientBuffers.get(socket) : upstreamBuffers.get(socket);
  const messages = currentBuffer.split('\n');
  
  // Process complete messages
  for (let i = 0; i < messages.length - 1; i++) {
    const message = messages[i].trim();
    if (message) {
      try {
        const parsed = JSON.parse(message);
        
        // Log important stratum messages
        if (parsed.method) {
          logger.debug(`Stratum method: ${parsed.method}`);
          
          // Handle difficulty adjustments if needed
          if (parsed.method === 'mining.set_difficulty' && CONFIG.DIFFICULTY_FACTOR !== 1.0) {
            const originalDiff = parsed.params[0];
            const adjustedDiff = originalDiff * CONFIG.DIFFICULTY_FACTOR;
            parsed.params[0] = adjustedDiff;
            logger.debug(`Adjusted difficulty: ${originalDiff} -> ${adjustedDiff}`);
            const modifiedMessage = JSON.stringify(parsed) + '\n';
            
            if (isFromClient) {
              const upstream = upstreamConnections.get(socket);
              upstream && upstream.write(modifiedMessage);
            } else {
              socket.write(modifiedMessage);
            }
            continue;
          }
        }
        
        // Forward message
        if (isFromClient) {
          const upstream = upstreamConnections.get(socket);
          if (upstream && !upstream.destroyed) {
            upstream.write(message + '\n');
            logger.debug(`Forwarded client -> pool: ${message.substring(0, 100)}`);
          }
        } else {
          if (socket && !socket.destroyed) {
            socket.write(message + '\n');
            logger.debug(`Forwarded pool -> client: ${message.substring(0, 100)}`);
          }
        }
      } catch (e) {
        // Non-JSON or incomplete message, forward as-is
        if (isFromClient) {
          const upstream = upstreamConnections.get(socket);
          if (upstream && !upstream.destroyed) {
            upstream.write(message + '\n');
          }
        } else {
          if (socket && !socket.destroyed) {
            socket.write(message + '\n');
          }
        }
      }
    }
  }
  
  // Keep incomplete message in buffer
  const lastMessage = messages[messages.length - 1];
  if (isFromClient) {
    clientBuffers.set(socket, lastMessage);
  } else {
    upstreamBuffers.set(socket, lastMessage);
  }
}

// ============= CLIENT HANDLING =============
function handleClientData(clientSocket, data) {
  processStratumMessage(data, clientSocket, true);
}

function handleUpstreamData(upstreamSocket, data) {
  // Find which client this upstream belongs to
  for (let [client, upstream] of upstreamConnections.entries()) {
    if (upstream === upstreamSocket) {
      processStratumMessage(data, client, false);
      break;
    }
  }
}

function handleClientClose(clientSocket) {
  const clientId = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
  logger.info(`Client disconnected: ${clientId}`);
  
  // Clean up upstream connection
  const upstream = upstreamConnections.get(clientSocket);
  if (upstream && !upstream.destroyed) {
    upstream.destroy();
  }
  
  // Clean up buffers
  clientBuffers.delete(clientSocket);
  upstreamConnections.delete(clientSocket);
  connectionCount--;
  logger.info(`Active connections: ${connectionCount}`);
}

function handleUpstreamClose(upstreamSocket) {
  logger.info(`Upstream connection closed`);
  
  // Find and close associated client
  for (let [client, upstream] of upstreamConnections.entries()) {
    if (upstream === upstreamSocket) {
      if (!client.destroyed) {
        client.destroy();
      }
      upstreamBuffers.delete(upstreamSocket);
      break;
    }
  }
}

function handleError(socket, error, type) {
  logger.error(`${type} error: ${error.message}`);
  if (!socket.destroyed) {
    socket.destroy();
  }
}

function handleClientConnection(clientSocket) {
  connectionCount++;
  totalConnectionsHandled++;
  const clientId = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
  logger.info(`New client connected: ${clientId} (Active: ${connectionCount}, Total: ${totalConnectionsHandled})`);
  
  // Check max connections
  if (connectionCount > CONFIG.MAX_CONNECTIONS) {
    logger.warn(`Max connections reached, rejecting client: ${clientId}`);
    clientSocket.write('{"error":"Max connections reached","id":null}\n');
    clientSocket.destroy();
    connectionCount--;
    return;
  }
  
  // Set socket options
  clientSocket.setKeepAlive(true, 60000);
  clientSocket.setTimeout(CONFIG.CONNECTION_TIMEOUT);
  
  // Create upstream connection for this client
  const upstreamSocket = new net.Socket();
  upstreamConnections.set(clientSocket, upstreamSocket);
  clientBuffers.set(clientSocket, '');
  upstreamBuffers.set(upstreamSocket, '');
  
  // Connect to upstream pool
  upstreamSocket.connect(CONFIG.UPSTREAM_PORT, CONFIG.UPSTREAM_HOST, () => {
    logger.info(`Upstream connected for client ${clientId} to ${CONFIG.UPSTREAM_HOST}:${CONFIG.UPSTREAM_PORT}`);
    
    // Send initial mining subscription when upstream connects
    let subscribeMsg;
    if (CONFIG.CUSTOM_SUBSCRIBE) {
      subscribeMsg = JSON.stringify(CONFIG.CUSTOM_SUBSCRIBE) + '\n';
    } else {
      subscribeMsg = '{"id":1,"method":"mining.subscribe","params":["StratumRelay/1.0.0"]}\n';
    }
    upstreamSocket.write(subscribeMsg);
    logger.debug(`Sent subscription request to pool`);
    
    // Also send authorize if needed (some pools require it)
    setTimeout(() => {
      const authMsg = '{"id":2,"method":"mining.authorize","params":["x", "x"]}\n';
      upstreamSocket.write(authMsg);
      logger.debug(`Sent authorization request to pool`);
    }, 100);
  });
  
  // Set up event handlers
  clientSocket.on('data', (data) => handleClientData(clientSocket, data));
  clientSocket.on('close', () => handleClientClose(clientSocket));
  clientSocket.on('error', (err) => handleError(clientSocket, err, 'Client'));
  clientSocket.on('timeout', () => {
    logger.warn(`Client ${clientId} timed out`);
    clientSocket.destroy();
  });
  
  upstreamSocket.on('data', (data) => handleUpstreamData(upstreamSocket, data));
  upstreamSocket.on('close', () => handleUpstreamClose(upstreamSocket));
  upstreamSocket.on('error', (err) => handleError(upstreamSocket, err, 'Upstream'));
  upstreamSocket.on('connect', () => {
    // Already handled above
  });
}

// ============= HEALTH CHECK SERVER =============
function setupHealthCheck() {
  const healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        connections: connectionCount,
        max_connections: CONFIG.MAX_CONNECTIONS,
        upstream: `${CONFIG.UPSTREAM_HOST}:${CONFIG.UPSTREAM_PORT}`,
        difficulty_factor: CONFIG.DIFFICULTY_FACTOR,
        uptime: process.uptime(),
        memory_usage: process.memoryUsage().rss / 1024 / 1024,
        timestamp: new Date().toISOString()
      }));
    } else if (req.url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        active_connections: connectionCount,
        total_connections_handled: totalConnectionsHandled,
        upstream: `${CONFIG.UPSTREAM_HOST}:${CONFIG.UPSTREAM_PORT}`,
        config: {
          max_connections: CONFIG.MAX_CONNECTIONS,
          timeout: CONFIG.CONNECTION_TIMEOUT,
          difficulty_factor: CONFIG.DIFFICULTY_FACTOR
        },
        node_version: process.version,
        platform: process.platform
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  
  healthServer.listen(CONFIG.HEALTH_PORT, '0.0.0.0', () => {
    logger.info(`Health check server listening on port ${CONFIG.HEALTH_PORT}`);
    logger.info(`Health endpoints: /health and /stats`);
  });
  
  healthServer.on('error', (err) => {
    logger.warn(`Health check server error: ${err.message}`);
  });
}

// ============= START RELAY =============
function startRelay() {
  const server = net.createServer(handleClientConnection);
  
  server.listen(CONFIG.PORT, '0.0.0.0', () => {
    logger.info(`========================================`);
    logger.info(`Stratum Relay Started Successfully`);
    logger.info(`========================================`);
    logger.info(`Listening on: 0.0.0.0:${CONFIG.PORT}`);
    logger.info(`Upstream pool: ${CONFIG.UPSTREAM_HOST}:${CONFIG.UPSTREAM_PORT}`);
    logger.info(`Max connections: ${CONFIG.MAX_CONNECTIONS}`);
    logger.info(`Connection timeout: ${CONFIG.CONNECTION_TIMEOUT}ms`);
    logger.info(`Health check: http://0.0.0.0:${CONFIG.HEALTH_PORT}/health`);
    logger.info(`========================================`);
  });
  
  server.maxConnections = CONFIG.MAX_CONNECTIONS;
  
  server.on('error', (err) => {
    logger.error(`Server error: ${err.message}`);
    process.exit(1);
  });
  
  setupHealthCheck();
}

// Test upstream pool connection on startup
function testUpstreamConnection() {
  const testSocket = new net.Socket();
  testSocket.setTimeout(5000);
  
  testSocket.on('connect', () => {
    logger.info(`✓ Successfully connected to upstream pool ${CONFIG.UPSTREAM_HOST}:${CONFIG.UPSTREAM_PORT}`);
    testSocket.destroy();
  });
  
  testSocket.on('error', (err) => {
    logger.error(`✗ Cannot connect to upstream pool ${CONFIG.UPSTREAM_HOST}:${CONFIG.UPSTREAM_PORT} - ${err.message}`);
    logger.warn(`Make sure the pool address and port are correct`);
  });
  
  testSocket.on('timeout', () => {
    logger.error(`✗ Connection timeout to upstream pool ${CONFIG.UPSTREAM_HOST}:${CONFIG.UPSTREAM_PORT}`);
    testSocket.destroy();
  });
  
  testSocket.connect(CONFIG.UPSTREAM_PORT, CONFIG.UPSTREAM_HOST);
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, closing server...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, closing server...');
  process.exit(0);
});

// Start the relay
testUpstreamConnection();
setTimeout(() => {
  startRelay();
}, 1000);
