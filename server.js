const { serveHTTP } = require("stremio-addon-sdk");
const addonInterface = require("./addon");

const port = process.env.PORT || 7000;

serveHTTP(addonInterface, { port: port });

console.log(`Addon server listening on port ${port}`);
