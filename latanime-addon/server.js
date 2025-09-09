#!/usr/bin/env node
const { serveHTTP } = require("stremio-addon-sdk");

const PORT = process.env.PORT || 7000;

// Load the addon
let addonInterface;
try {
  addonInterface = require("./addon");
  console.log("✅ Addon loaded successfully");
  console.log("✅ Manifest exists:", !!addonInterface.manifest);
  console.log("✅ AddonInterface type:", typeof addonInterface);
  
  if (addonInterface.manifest) {
    console.log("✅ Addon ID:", addonInterface.manifest.id);
    console.log("✅ Addon Name:", addonInterface.manifest.name);
  }
} catch (error) {
  console.error("❌ Failed to load addon:", error.message);
  process.exit(1);
}

// Validate addon interface
if (!addonInterface || !addonInterface.manifest) {
  console.error("❌ Invalid addon interface");
  process.exit(1);
}

// Start the server
console.log("🚀 Starting server...");

serveHTTP(addonInterface, { port: PORT }, function (err, h) {
  if (err) {
    console.error("❌ Server error:", err);
    process.exit(1);
  }
  
  console.log(`✅ Latanime Stremio addon running on port ${PORT}`);
  console.log(`📺 Manifest: http://localhost:${PORT}/manifest.json`);
  console.log(`🔗 Add to Stremio: http://localhost:${PORT}/manifest.json`);
});
