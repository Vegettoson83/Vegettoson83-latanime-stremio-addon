#!/usr/bin/env node
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 7000;

// Load the addon
let addonInterface;
try {
  addonInterface = require("./addon");
  console.log("✅ Addon loaded successfully");
  console.log("✅ Manifest:", addonInterface.manifest.name);
} catch (error) {
  console.error("❌ Failed to load addon:", error.message);
  process.exit(1);
}

// Create Express app
const app = express();

// Enable CORS for all requests
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With']
}));

// Parse JSON
app.use(express.json());

// Add request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'latanime-addon'
  });
});

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
  res.json(addonInterface.manifest);
});

// Use the addon interface directly for all other requests
app.use('/', (req, res, next) => {
  // Skip health and manifest routes
  if (req.path === '/health' || req.path === '/manifest.json') {
    return next();
  }
  
  // Call the addon interface directly
  if (addonInterface && typeof addonInterface === 'function') {
    return addonInterface(req, res);
  } else if (addonInterface && addonInterface.get) {
    // Handle newer SDK format
    addonInterface.get(req.path)
      .then(result => {
        res.json(result);
      })
      .catch(error => {
        console.error('❌ Addon error:', error);
        res.status(500).json({ error: error.message });
      });
  } else {
    res.status(404).json({ error: 'Handler not found' });
  }
});

// Catch all other requests
app.get('*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Latanime addon running on port ${PORT}`);
  console.log(`📺 Manifest: http://localhost:${PORT}/manifest.json`);
  console.log(`❤️  Health: http://localhost:${PORT}/health`);
  console.log(`🔗 Add to Stremio: http://localhost:${PORT}/manifest.json`);
  
  // Test the catalog endpoint
  setTimeout(async () => {
    console.log('\n🔍 Testing catalog endpoint...');
    try {
      const testReq = { path: '/catalog/series/latanime-top.json' };
      if (addonInterface.get) {
        const result = await addonInterface.get(testReq.path);
        console.log(`✅ Catalog test: Found ${result.metas?.length || 0} items`);
      }
    } catch (error) {
      console.error('❌ Catalog test failed:', error.message);
    }
  }, 2000);
});
