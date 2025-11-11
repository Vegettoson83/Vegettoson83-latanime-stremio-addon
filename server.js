const { serveHTTP } = require('stremio-addon-sdk');
const addonInterface = require('./addon');

const PORT = process.env.PORT || 7000;

serveHTTP(addonInterface, { port: PORT })
  .then(() => console.log(`Latanime add-on running on port ${PORT}`))
  .catch(err => console.error('Failed to start server:', err));
