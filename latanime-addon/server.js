#!/usr/bin/env node
const { serveHTTP } = require("stremio-addon-sdk");

const PORT = process.env.PORT || 7000;

// First, let's test if the addon loads correctly
let addonInterface;
try {
  addonInterface = require("./addon");
  console.log("✅ Addon loaded successfully");
  console.log("✅ Manifest exists:", !!addonInterface.manifest);
  if (addonInterface.manifest) {
    console.log("✅ Addon ID:", addonInterface.manifest.id);
    console.log("✅ Addon Name:", addonInterface.manifest.name);
  }
} catch (error) {
  console.error("❌ Failed to load addon:", error.message);
  console.error("Full error:", error);
  process.exit(1);
}

// Check if it's actually an AddonInterface
if (!addonInterface || typeof addonInterface !== 'function') {
  console.error("❌ addonInterface is not a function:", typeof addonInterface);
  process.exit(1);
}

if (!addonInterface.manifest) {
  console.error("❌ addonInterface is missing manifest property");
  process.exit(1);
}

// Start the server directly with the addon interface
try {
  console.log("🚀 Starting server...");
  serveHTTP(addonInterface, { port: PORT });
  
  console.log(`✅ Latanime Stremio addon running on port ${PORT}`);
  console.log(`📺 Addon URL: http://localhost:${PORT}/manifest.json`);
  console.log(`🔗 Add to Stremio: http://localhost:${PORT}/manifest.json`);
} catch (error) {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
}
