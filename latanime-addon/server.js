#!/usr/bin/env node
const { serveHTTP, getRouter } = require("stremio-addon-sdk");
const addonInterface = require("./addon");

const PORT = process.env.PORT || 7000;

// Enhanced CORS wrapper with better error handling
function corsWrapper(req, res) {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Origin, X-Requested-With");
  res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    return res.end();
  }

  // Add request logging
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  try {
    // Call the original addon interface
    return addonInterface(req, res);
  } catch (error) {
    console.error('Addon error:', error);
    
    // Send error response
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'Internal server error',
        message: error.message 
      }));
    }
  }
}

// Add health check endpoint
function healthCheck(req, res) {
  if (req.url === '/health' || req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      service: 'latanime-addon'
    }));
    return true;
  }
  return false;
}

// Enhanced wrapper that includes health check
function enhancedWrapper(req, res) {
  // Handle health check requests
  if (healthCheck(req, res)) {
    return;
  }
  
  // Handle regular addon requests
  return corsWrapper(req, res);
}

// Start the server
try {
  serveHTTP(enhancedWrapper, { port: PORT });
  console.log(`🚀 Latanime Stremio addon running on port ${PORT}`);
  console.log(`📺 Addon URL: http://localhost:${PORT}/manifest.json`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
  console.log(`🌐 CORS enabled for all origins`);
} catch (error) {
  console.error('Failed to start server:', error);
  process.exit(1);
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
