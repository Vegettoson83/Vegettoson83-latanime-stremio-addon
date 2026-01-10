const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const playwright = require('playwright');
const NodeCache = require('node-cache');
const cors = require('cors');
const manifest = require('./lib/manifest');
const { defineHandlers } = require('./lib/handlers');

const builder = new addonBuilder(manifest);

let browser;

const getBrowser = () => browser;

defineHandlers(builder, getBrowser);

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
    try {
        browser = await playwright.chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process'
            ]
        });
        console.log('Playwright browser launched successfully.');

        app.listen(port, () => {
            console.log(`Addon server listening on port ${port}`);
        });
    } catch (error) {
        console.error('Failed to launch browser or start server:', error);
        process.exit(1);
    }
}

async function gracefulShutdown() {
    console.log('Received shutdown signal. Closing browser...');
    if (browser) {
        await browser.close();
        console.log('Browser closed.');
    }
    process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

startServer();
