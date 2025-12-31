// bridge-server.js
const express = require('express');
const playwright = require('playwright');
const NodeCache = require('node-cache');
const cors = require('cors');

const app = express();
app.use(cors());

// Cache extracted streams for 1 hour (not the m3u8 itself, just the URL)
const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// Helper function to click common play buttons or overlays
const clickPlayButton = async (page) => {
    // A list of common selectors for play buttons
    const selectors = [
        // Generic Selectors
        '[aria-label="Play"]',
        '[aria-label="play"]',
        'button[title="Play"]',
        'div[role="button"][aria-label="Play"]',
        // Common Player Libraries
        '.vjs-big-play-button', // Video.js
        'button.vjs-big-play-button',
        'div[data-plyr="play"]', // Plyr
        '.plyr__control--overlaid',
        '.jw-video.jw-reset', // JWPlayer (often the video element itself)
        '.jw-icon-playback',
        // Site-specific / Common Patterns
        '.big-play-button',
        'div[class*="play_button"]',
        '#player_img_play',
        '#vjs-play-start', // Another video.js variant
        '.play-btn'
    ];

    for (const selector of selectors) {
        try {
            // Use page.locator for better interaction checks
            const button = page.locator(selector).first();
            const count = await button.count();
            if (count > 0) {
                console.log(`Found potential play button with selector: ${selector}. Attempting to click.`);
                await button.click({ timeout: 5000, force: true }); // Use force to click through overlays
                console.log('Successfully clicked play button.');
                // Wait a moment for the video player to initialize after the click
                await page.waitForTimeout(3000);
                return true; // Indicate that a button was clicked
            }
        } catch (error) {
            // Log silently, as we expect some selectors to fail
            // console.log(`Selector ${selector} not found or failed to click. Trying next...`);
        }
    }
    console.log('No common play button found to click.');
    return false; // No button was clicked
};


// Providers we know how to extract from
const PROVIDERS = {
    // Re-engineered extractors with corrected logic
    'voe.sx': async (page) => {
        console.log('Attempting to click Voe play button...');
        await clickPlayButton(page);

        await page.waitForTimeout(3000); // Wait for scripts to load after interaction

        console.log('Extracting Voe stream URL...');
        return await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                // Look for the hls source defined in obfuscated scripts
                const match = script.textContent.match(/'hls':\s*'([^']+)'/);
                if (match && match[1]) return match[1];
            }
            // Fallback to video element if script search fails
            const video = document.querySelector('video');
            return video?.src || null;
        });
    },
    'filemoon.sx': async (page) => {
        // Filemoon has no iframe, it's a direct player
        console.log('Attempting to click Filemoon play button...');
        await clickPlayButton(page);

        // Wait for the obfuscated player script to execute and define sources
        await page.waitForTimeout(4000); // Wait after clicking

        console.log('Extracting Filemoon stream URL...');
        return await page.evaluate(() => {
            // The source is often in a packed script that creates a jwplayer
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/file:"([^"]+\.m3u8[^"]*)"/);
                if (match && match[1]) return match[1];
            }
            return null;
        });
    },
    'luluvid.com': async (page) => {
        await page.waitForTimeout(2000);
        return await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/file:"([^"]+\.m3u8[^"]*)"/);
                if (match && match[1]) return match[1];
            }
            return null;
        });
    },

    // --- Existing Providers (kept for compatibility) ---
    'yourupload.com': async (page) => {
        await page.waitForSelector('video');
        const videoSrc = await page.evaluate(() => {
            const video = document.querySelector('video');
            return video?.src || video?.querySelector('source')?.src;
        });
        return videoSrc;
    },
    'mp4upload.com': async (page) => {
        await page.waitForTimeout(3000);
        const sources = await page.evaluate(() => {
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
        await page.waitForSelector('iframe');
        const iframeSrc = await page.$eval('iframe', el => el.src);
        if (iframeSrc.includes('m3u8')) return iframeSrc;
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
// Add aliases for domains that use the same player logic
PROVIDERS['ico3c.com'] = PROVIDERS['filemoon.sx'];
PROVIDERS['dsvplay.com'] = PROVIDERS['luluvid.com'];
PROVIDERS['mxdrop.to'] = PROVIDERS['luluvid.com'];


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
            // Enhanced generic extraction
            console.log('No specific extractor found, using generic fallback.');

            // First, attempt to click any common play buttons that might be overlaying the content.
            await clickPlayButton(page);

            videoUrl = await page.evaluate(() => {
                // 1. Check video tags directly
                const video = document.querySelector('video');
                if (video?.src && (video.src.includes('.m3u8') || video.src.includes('.mp4'))) {
                    return video.src;
                }
                const source = document.querySelector('video source');
                if (source?.src && (source.src.includes('.m3u8') || source.src.includes('.mp4'))) {
                    return source.src;
                }

                // 2. Scan all scripts for .m3u8 or .mp4 URLs
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const script of scripts) {
                    const content = script.textContent || '';
                    let match = content.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
                    if (match) return match[0];
                    match = content.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/);
                    if (match) return match[0];
                }

                // 3. Look for URLs in window object properties
                for (const key in window) {
                    if (typeof window[key] === 'string') {
                        const value = window[key];
                        if (value.includes('.m3u8') || value.includes('.mp4')) {
                            let match = value.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
                            if (match) return match[0];
                            match = value.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/);
                            if (match) return match[0];
                        }
                    }
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
            const providerName = new URL(url).hostname.replace('www.', '').split('.')[0];
            const screenshotPath = `failed_${providerName}_${Date.now()}.png`;
            console.log(`No video URL found. Saving screenshot to ${screenshotPath} for debugging...`);
            await page.screenshot({ path: screenshotPath });
            res.status(404).json({ error: `No video source found. Screenshot saved to ${screenshotPath}` });
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
