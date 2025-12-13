const { serveHTTP } = require('stremio-addon-sdk');
const addonInterface = require('./addon');

const PORT = process.env.PORT || 7000;

serveHTTP(addonInterface, { port: PORT });
console.log(`Stremio addon server listening on http://127.0.0.1:${PORT}`);
