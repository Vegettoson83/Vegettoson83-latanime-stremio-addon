#!/usr/bin/env node

const http = require('http');
const addon = require('./addon');
const PORT = process.env.PORT || 7000;

const server = http.createServer((req, res) => {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  try {
    return addon(req, res);
  } catch (err) {
    console.error('Error delegating request to addon interface:', err);
    res.writeHead(500);
    res.end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`Addon server listening on port ${PORT}`);
});
