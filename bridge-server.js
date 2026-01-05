// bridge-server.js

// 🎯 CRITICAL: Set this BEFORE anything else
process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/render/project/src/.cache/ms-playwright';

const express = require('express');
const playwright = require('playwright');
const NodeCache = require('node-cache');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Cache extracted streams for 1 hour
const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// Global browser instance
let browser;

// Providers we know how to extract from
const PROVIDERS = {
    'yourupload.com': async (page) => {
        await page.waitForSelector('video');
        return page.evaluate(() => document.querySelector('video')?.src || document.querySelector('video source')?.src);
    },
    'mp4upload.com': async (page) => {
        // Final, more robust approach: wait for the video element to be ready
        await page.waitForSelector('video', { state: 'visible', timeout: 20000 });
        return page.evaluate(() => {
            // First, try to get from player setup scripts, which is common
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/https?:\/\/[^"']+\.(mp4|m3u8)[^"']*/);
                if (match) return match[0];
            }
            // Fallback to the video element itself if not in a script
            const video = document.querySelector('video');
            return video?.src || video?.querySelector('source')?.src;
        });
    },
    'vidsrc.to': async (page) => {
        await page.waitForSelector('iframe');
        const iframeSrc = await page.$eval('iframe', el => el.src);
        if (iframeSrc.includes('m3u8')) return iframeSrc;
        return page.evaluate(() => {
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const match = script.textContent.match(/https?:\/\/[^"']+\.m3u8[^"']*/);
                if (match) return match[0];
            }
            return null;
        });
    }
};

async function extractVideoUrl(url, referer = null) {
    const cacheKey = `video_url:${url}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
        console.log(`Cache hit for final URL: ${url}`);
        return cached;
    }

    const page = await browser.newPage();
    try {
        await page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': referer || new URL(url).origin,
        });
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

        const detectedProvider = Object.keys(PROVIDERS).find(p => url.includes(p));
        const extractor = detectedProvider ? PROVIDERS[detectedProvider] : null;

        let videoUrl;
        if (extractor) {
            videoUrl = await extractor(page);
        } else {
            videoUrl = await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video?.src) return video.src;
                const source = document.querySelector('video source');
                if (source?.src) return source.src;
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const script of scripts) {
                    const match = script.textContent.match(/https?:\/\/[^\s"']+\.(?:m3u8|mp4)[^\s"']*/);
                    if (match) return match[0];
                }
                return null;
            });
        }

        if (videoUrl) {
            streamCache.set(cacheKey, videoUrl);
        }
        return videoUrl;
    } finally {
        await page.close();
    }
}

app.post('/extract-streams', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }
    if (!browser) {
        return res.status(503).json({ error: 'Browser is not ready, please try again later.' });
    }

    console.log(`Scraping latanime page: ${url}`);
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        const providers = await page.evaluate(() => {
            const results = [];
            const baseKey = document.querySelector('div.player')?.getAttribute('data-key');
            if (!baseKey) return [];
            const basePlayerUrl = atob(baseKey);
            document.querySelectorAll('a.play-video').forEach(el => {
                const providerName = el.textContent.trim();
                const encodedPart = el.getAttribute('data-player');
                if (encodedPart) {
                    const intermediateUrl = providerName.toLowerCase() === 'yourupload' ? atob(encodedPart) : basePlayerUrl + encodedPart;
                    results.push({ url: intermediateUrl, title: providerName });
                }
            });
            return results;
        });
        console.log(`Found ${providers.length} potential providers.`);

        const finalEmbedUrls = await Promise.all(providers.map(async (provider) => {
            const providerPage = await browser.newPage();
            try {
                await providerPage.goto(provider.url, { waitUntil: 'domcontentloaded' });
                const finalUrl = await providerPage.evaluate(() => {
                    const redirMatch = document.body.innerHTML.match(/var redir = atob\("([^"]+)"\);/);
                    return redirMatch ? atob(redirMatch[1]) : null;
                });
                return { ...provider, finalUrl };
            } catch (e) {
                console.error(`Failed to get final embed from ${provider.url}: ${e.message}`);
                return null;
            } finally {
                await providerPage.close();
            }
        }));
        const validEmbeds = finalEmbedUrls.filter(p => p && p.finalUrl && !p.finalUrl.includes('listeamed.net'));
        console.log(`Found ${validEmbeds.length} valid final embed URLs (after filtering).`);

        const streamPromises = validEmbeds.map(async (provider) => {
            try {
                const videoUrl = await extractVideoUrl(provider.finalUrl, provider.url);
                if (videoUrl) {
                    console.log(`✅ Extracted: ${provider.title} -> ${videoUrl.substring(0, 60)}...`);
                    return {
                        name: 'Latanime',
                        url: videoUrl,
                        title: provider.title,
                        behaviorHints: {
                            proxyHeaders: {
                                'request': {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                    'Referer': new URL(provider.finalUrl).origin
                                }
                            }
                        }
                    };
                }
            } catch (error) {
                console.log(`❌ Extraction failed for ${provider.finalUrl}: ${error.message}`);
            }
            return null;
        });
        const resolvedStreams = (await Promise.all(streamPromises)).filter(Boolean);

        const downloadLinks = await page.evaluate(() => {
            const links = [];
            const selectors = [
                'a[href*="pixeldrain.com"]', 'a[href*="mediafire.com"]', 'a[href*="mega.nz"]',
                'a[href*="gofile.io"]', 'a[href*="drive.google.com"]', 'a[href*="1fichier.com"]',
                'a[download]'
            ];
            document.querySelectorAll(selectors.join(',')).forEach(el => {
                if (el.href) links.push({ url: el.href, title: `📥 ${el.textContent.trim() || 'Download'}` });
            });
            return links;
        });

        const allStreams = [...resolvedStreams, ...downloadLinks];
        console.log(`Total streams found: ${allStreams.length}`);
        res.json({ streams: allStreams });
    } catch (error) {
        console.error(`Scraping error on ${url}: ${error.message}`);
        res.status(500).json({ error: error.message, streams: [] });
    } finally {
        await page.close();
    }
});

const PORT = process.env.BRIDGE_PORT || 3001;

async function startServer() {
    try {
        // 🎯 FIX: Memory-saving args for Render + use persistent browser path
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

        app.listen(PORT, () => {
            console.log(`Iframe Bridge running on http://localhost:${PORT}`);
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
