const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const cors = require('cors');
const manifest = require('./lib/manifest');
const { defineHandlers } = require('./lib/handlers');
const { startBrowser, gracefulShutdown, getBrowser } = require('./lib/browser');

const builder = new addonBuilder(manifest);

defineHandlers(builder, { getBrowser });

const addonInterface = builder.getInterface();
const app = express();
app.use(cors());
app.use(express.json());

app.use('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(addonInterface.manifest);
});

app.use(getRouter(addonInterface));

const port = process.env.PORT || 10000;

async function startServer() {
    await startBrowser();
    app.listen(port, () => {
        console.log(`Addon server listening on port ${port}`);
    });
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

startServer();
