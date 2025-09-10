#!/usr/bin/env node
const { serveHTTP } = require("stremio-addon-sdk");
const addonInterface = require("./addon");

const port = process.env.PORT || 10000;

serveHTTP(addonInterface, { port });

console.log(`Addon running on port ${port}`);
