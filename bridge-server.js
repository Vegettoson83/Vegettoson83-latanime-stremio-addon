const express = require('express');
const playwright = require('playwright');
const NodeCache = require('node-cache');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

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

async function extractVideoUrl(context, url, referer = null) {
    const cacheKey = `video_url:${url}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
        console.log(`Cache hit for final URL: ${url}`);
        return cached;
    }

    const page = await context.newPage();
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

    const context = await browser.newContext();
    try {
        console.log(`Scraping latanime page: ${url}`);
        const page = await context.newPage();
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded' });

            const providers = await page.evaluate(() => {
                const scripts = Array.from(document.querySelectorAll('script'));
                const videoScript = scripts.find(s => s.textContent.includes('const videos ='));
                if (!videoScript) return [];

                const videoDataMatch = videoScript.textContent.match(/const videos = (\[\[.*?\]\]);/);
                if (!videoDataMatch) return [];

                try {
                    const videos = JSON.parse(videoDataMatch[1].replace(/'/g, '"'));
                    return videos.map(video => ({
                        url: `https://latanime.org/reproductor?url=${video[2]}`,
                        title: video[0]
                    }));
                } catch (e) {
                    console.error('Failed to parse video data:', e);
                    return [];
                }
            });
        console.log(`Found ${providers.length} potential providers.`);

        const finalEmbedUrls = await Promise.all(providers.map(async (provider) => {
            const providerPage = await context.newPage();
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
        // Filter out known problematic or ad-related domains
        const validEmbeds = finalEmbedUrls.filter(p => p && p.finalUrl && !p.finalUrl.includes('listeamed.net'));
        console.log(`Found ${validEmbeds.length} valid final embed URLs (after filtering).`);

        const streamPromises = validEmbeds.map(async (provider) => {
            console.log(`Attempting to extract stream from ${provider.title} at ${provider.finalUrl}`);
            try {
                const videoUrl = await extractVideoUrl(context, provider.finalUrl, provider.url);
                if (videoUrl && !videoUrl.includes('bigbuckbunny')) {
                    console.log(`✅ Success: Extracted from ${provider.title} -> ${videoUrl.substring(0, 60)}...`);
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
                } else if (videoUrl) {
                    console.log(`⚠️ Filtered placeholder URL from ${provider.title}: ${videoUrl}`);
                } else {
                    console.log(`ℹ️ No video URL found for ${provider.title}`);
                }
            } catch (error) {
                console.error(`❌ Error extracting from ${provider.title} (${provider.finalUrl}): ${error.message}`);
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
        } finally {
            await page.close();
        }
    } catch (error) {
        console.error(`Scraping error on ${url}: ${error.message}`);
        res.status(500).json({ error: error.message, streams: [] });
    } finally {
        await context.close();
    }
});

const port = process.env.BRIDGE_PORT || 3001;
let browser;

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
        console.log('Playwright browser launched successfully for bridge.');

        app.listen(port, () => {
            console.log(`Bridge server listening on port ${port}`);
        });
    } catch (error) {
        console.error('Failed to launch browser or start bridge server:', error);
        process.exit(1);
    }
}

async function gracefulShutdown() {
    console.log('Received shutdown signal. Closing browser...');
    if (browser) {
        await browser.close();
        console.log('Bridge browser closed.');
    }
    process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

startServer();
