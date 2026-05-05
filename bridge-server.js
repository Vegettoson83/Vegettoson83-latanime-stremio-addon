
import express from 'express';
import { chromium } from 'playwright-chromium';
import { handleExtraction } from './lib/handlers.js';

const app = express();
const PORT = 3001;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "latanime-secret-token";

let browser = null;
let activePages = 0;
const MAX_PAGES = 8;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

  if (browser) {
    console.log('[Bridge] Closing disconnected browser...');
    await browser.close().catch(() => {});
  }

  console.log('[Bridge] Launching browser...');
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    });
    console.log('[Bridge] Browser launched successfully');
  } catch (e) {
    console.error(`[Bridge] Failed to launch browser: ${e.message}`);
    throw e;
  }

  return browser;
}

app.get('/extract', async (req, res) => {
  const { url, token } = req.query;

  if (token !== BRIDGE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!url) return res.status(400).json({ error: 'Missing url' });

  if (activePages >= MAX_PAGES) {
    return res.status(503).json({ error: 'Server busy' });
  }

  activePages++;
  let context = null;
  let page = null;

  try {
    const b = await getBrowser();
    context = await b.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });
    page = await context.newPage();

    const streamUrl = await Promise.race([
      handleExtraction(page, url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Extraction timeout')), 45000))
    ]);

    res.json({ url: streamUrl });
  } catch (e) {
    console.error(`[Bridge] Extraction failed for ${url}: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    activePages--;
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
});

app.get('/_health', (req, res) => {
  res.json({ status: 'ok', activePages, browserConnected: browser?.isConnected() || false });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bridge server listening on 0.0.0.0:${PORT}`);
});
