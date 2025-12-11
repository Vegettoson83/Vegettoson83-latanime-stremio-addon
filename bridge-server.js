// bridge-server.js
const express = require('express');
const playwright = require('playwright');
const NodeCache = require('node-cache');
const cors = require('cors');

const app = express();
app.use(cors());

// Cache extracted streams for 1 hour (not the m3u8 itself, just the URL)
const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// Providers we know how to extract from
const PROVIDERS = {
    'yourupload.com': async (page) => {
        await page.waitForSelector('video');
        const videoSrc = await page.evaluate(() => {
            const video = document.querySelector('video');
            return video?.src || video?.querySelector('source')?.src;
        });
        return videoSrc;
    },
    'mp4upload.com': async (page) => {
        // Wait for the player script to load
        await page.waitForTimeout(3000);
        const sources = await page.evaluate(() => {
            // mp4upload often has the source in a global var or script
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/https?:\/\/[^"']+\.m3u8[^"']*/);
                if (match) return match[0];
            }
            return null;
        });
        return sources;
    },
    'vidsrc.to': async (page) => {
        // Well-known pattern
        await page.waitForSelector('iframe');
        const iframeSrc = await page.$eval('iframe', el => el.src);
        if (iframeSrc.includes('m3u8')) return iframeSrc;

        // Or extract from scripts
        const m3u8 = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const match = script.textContent.match(/https?:\/\/[^"']+\.m3u8[^"']*/);
                if (match) return match[0];
            }
            return null;
        });
        return m3u8;
    }
};

app.get('/extract', async (req, res) => {
    const { url, provider } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'URL parameter required' });
    }

    // Check cache first
    const cached = streamCache.get(url);
    if (cached) {
        console.log(`Cache hit for ${url}`);
        return res.json({ success: true, url: cached, cached: true });
    }

    console.log(`Extracting from: ${url}`);
    let browser = null;

    try {
        browser = await playwright.chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

        // Set user agent and headers
        await page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });

        // Go to the embed URL
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

        // Try to detect provider automatically
        const detectedProvider = Object.keys(PROVIDERS).find(p => url.includes(p));
        const extractor = detectedProvider ? PROVIDERS[detectedProvider] : null;

        let videoUrl = null;

        if (extractor) {
            console.log(`Using extractor for ${detectedProvider}`);
            videoUrl = await extractor(page);
        } else {
            // Generic extraction: look for video elements or m3u8 in scripts
            videoUrl = await page.evaluate(() => {
                // Check video tags
                const video = document.querySelector('video');
                if (video?.src) return video.src;

                const source = document.querySelector('video source');
                if (source?.src) return source.src;

                // Check for m3u8 in all scripts
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const script of scripts) {
                    const match = script.textContent.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/);
                    if (match) return match[0];
                }

                return null;
            });
        }

        if (videoUrl && (videoUrl.includes('.m3u8') || videoUrl.includes('.mp4'))) {
            // Cache the result
            streamCache.set(url, videoUrl);

            console.log(`Extracted: ${videoUrl}`);
            res.json({ success: true, url: videoUrl });
        } else {
            console.log(`No video URL found. Taking screenshot for debugging...`);
            // For debugging, you can screenshot: await page.screenshot({ path: 'debug.png' });
            res.status(404).json({ error: 'No video source found' });
        }

    } catch (error) {
        console.error(`Extraction error: ${error.message}`);
        res.status(500).json({ error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

const PORT = process.env.BRIDGE_PORT || 3001;
app.listen(PORT, () => {
    console.log(`Iframe Bridge running on http://localhost:${PORT}`);
});
