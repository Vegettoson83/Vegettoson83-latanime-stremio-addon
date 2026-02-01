const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const cors = require('cors');
const playwright = require('playwright');
const manifest = require('./lib/manifest');
const { defineHandlers } = require('./lib/handlers');

let browser;

async function startBrowser() {
    try {
        browser = await playwright.chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
        });
        console.log('[Server] Playwright browser launched successfully.');
    } catch (error) {
        console.error('[Server] Failed to launch browser:', error);
        process.exit(1);
    }
}

async function gracefulShutdown() {
    console.log('[Server] Received shutdown signal. Closing browser...');
    if (browser) {
        await browser.close();
        console.log('[Server] Browser closed.');
    }
    process.exit(0);
}

function getBrowser() {
    if (!browser) throw new Error("Browser has not been initialized.");
    return browser;
}

const builder = new addonBuilder(manifest);

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

startBrowser().then(() => {
    app.listen(port, () => {
        console.log(`Addon server listening on port ${port}`);
    });
}).catch(err => {
    console.error("Failed to start browser and server:", err);
    process.exit(1);
});

process.on('uncaughtException', (err, origin) => {
  console.error(`[Server] Uncaught Exception at: ${origin}, error: ${err}`);
  process.exit(1);
});

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
