
import express from 'express';
import { chromium } from 'playwright';
import { handleExtraction } from './lib/handlers.js';

const app = express();
const PORT = 3001;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "latanime-secret-token";

let browser;
let activePages = 0;
const MAX_PAGES = 10;

(async () => {
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
})();

app.get('/extract', async (req, res) => {
  const { url, token } = req.query;

  if (token !== BRIDGE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!url) return res.status(400).json({ error: 'Missing url' });

  if (activePages >= MAX_PAGES) {
    return res.status(503).json({ error: 'Server busy, try again later' });
  }

  activePages++;
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const streamUrl = await handleExtraction(page, url);
    res.json({ url: streamUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    activePages--;
    await page.close();
    await context.close();
  }
});

// Removed /fetch endpoint to prevent open proxy vulnerability

app.listen(PORT, () => {
  console.log(`Bridge server listening on port ${PORT}`);
});
