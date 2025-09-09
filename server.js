#!/usr/bin/env node
const { serveHTTP } = require("stremio-addon-sdk");
const addonInterface = require("./addon");

const PORT = process.env.PORT || 7000;

// Wrap the AddonInterface to inject CORS headers
function corsWrapper(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Origin, X-Requested-With");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    return res.end();
  }

  return addonInterface(req, res); // call original addon interface
}

serveHTTP(corsWrapper, { port: PORT });
console.log(`Latanime Stremio addon running on port ${PORT} with CORS enabled`);
