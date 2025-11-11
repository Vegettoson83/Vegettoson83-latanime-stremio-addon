const { serveHTTP } = require('stremio-addon-sdk');
const addonInterface = require('./addon');

const port = process.env.PORT || 3000;

serveHTTP(addonInterface, { port });