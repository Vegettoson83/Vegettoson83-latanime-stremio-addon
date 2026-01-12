const express = require('express');
const playwright = require('playwright');
const NodeCache = require('node-cache');

const app = express();
app.use(express.json());

const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
let browser;

const PROVIDERS = {
    'yourupload.com': async (page) => {
        await page.waitForSelector('video');
        return page.evaluate(() => document.querySelector('video')?.src || document.querySelector('video source')?.src);
    },
    'mp4upload.com': async (page) => {
        await page.waitForSelector('video', { state: 'visible', timeout: 20000 });
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/https?:\/\/[^"']+\.(mp4|m3u8)[^"']*/);
                if (match) return match[0];
            }
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

async function extractVideoUrl(browser, url, referer = null) {
    const cacheKey = `video_url:${url}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
        console.log(`[Bridge] Cache hit for final URL: ${url}`);
        return cached;
    }

    let page;
    try {
        page = await browser.newPage();
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
        if (page) {
            await page.close();
        }
    }
}

app.post('/scrape', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    if (!browser) {
        return res.status(503).json({ error: 'Browser not initialized' });
    }

    console.log(`[Bridge] Scraping latanime page: ${url}`);
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
        console.log(`[Bridge] Found ${providers.length} potential providers.`);

        const resolvedStreams = [];
        for (const provider of providers) {
            let providerPage = null;
            try {
                providerPage = await browser.newPage();
                await providerPage.setRequestInterception(true);
                providerPage.on('request', (req) => {
                    if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
                        req.abort();
                    } else {
                        req.continue();
                    }
                });

                await providerPage.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 15000 });

                const finalUrl = await providerPage.evaluate(() => {
                    const redirMatch = document.body.innerHTML.match(/var redir = atob\("([^"]+)"\);/);
                    return redirMatch ? atob(redirMatch[1]) : null;
                });

                if (finalUrl && !finalUrl.includes('listeamed.net')) {
                    console.log(`[Bridge] Found valid final embed URL for ${provider.title}: ${finalUrl.substring(0, 60)}...`);
                    const videoUrl = await extractVideoUrl(browser, finalUrl, provider.url);
                    if (videoUrl) {
                        console.log(`[Bridge] ✅ Extracted: ${provider.title} -> ${videoUrl.substring(0, 60)}...`);
                        resolvedStreams.push({
                            name: 'Latanime',
                            url: videoUrl,
                            title: provider.title,
                            behaviorHints: {
                                proxyHeaders: {
                                    'request': {
                                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                        'Referer': new URL(finalUrl).origin
                                    }
                                }
                            }
                        });
                    }
                }
            } catch (e) {
                console.error(`[Bridge] Failed processing provider ${provider.title} (${provider.url}): ${e.message}`);
            } finally {
                if (providerPage) await providerPage.close();
            }
        }

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
        console.log(`[Bridge] Total streams found: ${allStreams.length}`);
        res.json({ streams: allStreams });

    } catch (error) {
        console.error(`[Bridge] Scraping error on ${url}: ${error.message}`);
        res.status(500).json({ error: 'Scraping failed', streams: [] });
    } finally {
        await page.close();
    }
});

const port = process.env.BRIDGE_PORT || 3001;

async function startBrowser() {
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
        console.log('[Bridge] Playwright browser launched successfully.');
    } catch (error) {
        console.error('[Bridge] Failed to launch browser:', error);
        process.exit(1);
    }
}

async function gracefulShutdown() {
    console.log('[Bridge] Received shutdown signal. Closing browser...');
    if (browser) {
        await browser.close();
        console.log('[Bridge] Browser closed.');
    }
    process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

app.listen(port, async () => {
    await startBrowser();
    console.log(`[Bridge] Server listening on port ${port}`);
});
