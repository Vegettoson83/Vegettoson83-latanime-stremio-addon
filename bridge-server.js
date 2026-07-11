import express from 'express';
import { chromium } from 'playwright-chromium';

const app = express();
const port = process.env.PORT_BRIDGE || 3001;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;

let browser;
const MAX_PAGES = 10;
let activePages = 0;

const ALLOWED_HOSTS = [
  'latanime.org',
  'filemoon.sx',
  'voe.sx',
  'lancewhosedifficult.com',
  'voeunblocked.com',
  'mxdrop.to',
  'dsvplay.com',
  'doodstream.com',
  'hexload.com',
  'mp4upload.com'
];

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
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
  }
  return browser;
}

app.get('/extract', async (req, res) => {
  const targetUrl = req.query.url;
  const token = req.query.token;

  if (!BRIDGE_TOKEN) {
    return res.status(500).send("BRIDGE_TOKEN not configured");
  }

  if (token !== BRIDGE_TOKEN) {
    return res.status(401).send("Unauthorized");
  }

  if (!targetUrl) return res.status(400).send("Missing url");

  try {
    const urlObj = new URL(targetUrl);
    if (!ALLOWED_HOSTS.some(host => urlObj.hostname.endsWith(host))) {
      return res.status(403).send("Forbidden Host");
    }
  } catch {
    return res.status(400).send("Invalid URL");
  }

  if (activePages >= MAX_PAGES) {
    return res.status(503).send("Server Busy");
  }

  activePages++;
  try {
    if (targetUrl.includes('.m3u8') || targetUrl.includes('.mp4')) {
      return res.json({ url: targetUrl });
    }

    const b = await getBrowser();
    const page = await b.newPage();
    let streamUrl = null;

    try {
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (!streamUrl && (url.includes('.m3u8') || (url.includes('.mp4') && !url.includes('analytics')))) {
          streamUrl = url;
        }
        route.continue();
      });

      await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});

      if (!streamUrl) {
        streamUrl = await page.evaluate(() => {
          const v = document.querySelector('video');
          if (v?.src?.includes('.m3u8')) return v.src;
          if (v?.currentSrc?.includes('.m3u8')) return v.currentSrc;

          const scripts = Array.from(document.querySelectorAll('script'));
          for (const s of scripts) {
            const m = s.textContent?.match(/["'`](https?:\/\/[^"'`\s]{10,}\.m3u8[^"'`\s]*)/);
            if (m) return m[1];
          }
          return null;
        });
      }

      res.json({ url: streamUrl });
    } finally {
      await page.close();
    }
  } catch (e) {
    res.status(500).send(String(e));
  } finally {
    activePages--;
  }
});

app.listen(port, () => {
  console.log(`Bridge server listening at http://localhost:${port}`);
});
