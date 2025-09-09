#!/usr/bin/env node

const { serveHTTP } = require("stremio-addon-sdk");
const addonInterface = require("./addon");

const PORT = process.env.PORT || 7000;

// Serve the addon
const server = serveHTTP(addonInterface, { port: PORT });

// Add CORS headers
server.on("request", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, Origin, X-Requested-With"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
  }
});

console.log(`Addon running on http://localhost:${PORT}`);

