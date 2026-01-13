const playwright = require('playwright');
const NodeCache = require('node-cache');
const axios = require('axios');

const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
let browser; // Global browser instance

const PROVIDERS = {
    // ... All provider logic remains the same
    'filemoon.sx': async (page) => {
        await page.waitForFunction(() => typeof jwplayer === 'function', null, { timeout: 15000 });
        return page.evaluate(() => {
            const script = document.querySelector('script[src*="master.m3u8"]');
            if (script) return script.src;
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/(https?:\/\/[^"']+\/master\.m3u8[^"']*)/);
                if (match) return match[0];
            }
            return null;
        });
    },
    'dsvplay.com': async (page) => {
        await page.waitForSelector('video', { timeout: 15000 });
        return page.evaluate(() => document.querySelector('video source')?.src || document.querySelector('video')?.src);
    },
    'mega.nz': () => null,
    'uqload.com': async (page) => {
        await page.waitForFunction(() => typeof jwplayer === 'function' || document.querySelector('video'), null, { timeout: 20000 });
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/sources:\s*\[{\s*file:\s*"(https?:\/\/[^"]+)"/);
                if (match) return match[1];
            }
            return document.querySelector('video source')?.src || document.querySelector('video')?.src;
        });
    },
    'luluvid.com': async (page) => {
        await page.waitForSelector('iframe', { timeout: 15000 });
        const iframeSrc = await page.$eval('iframe', el => el.src);
        await page.goto(iframeSrc, { waitUntil: 'networkidle' });
        await page.waitForSelector('video', { timeout: 15000 });
        return page.evaluate(() => document.querySelector('video source')?.src || document.querySelector('video')?.src);
    },
    'mxdrop.to': async (page) => {
        await page.waitForFunction(() => typeof jwplayer === 'function' || document.querySelector('video'), null, { timeout: 20000 });
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/file:\s*"(https?:\/\/[^"]+\.(mp4|m3u8)[^"]*)"/);
                if (match) return match[1];
            }
            return document.querySelector('video source')?.src || document.querySelector('video')?.src;
        });
    },
    'voe.sx': async (page) => {
        await page.waitForSelector('video', { timeout: 20000 });
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/'hls':\s*'(https?:\/\/[^']+\.m3u8)'/);
                if (match) return match[1];
            }
            return document.querySelector('video source')?.src || document.querySelector('video')?.src;
        });
    },
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

async function startBrowser() {
    try {
        browser = await playwright.chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
        });
        console.log('[Scraper] Playwright browser launched successfully.');
    } catch (error) {
        console.error('[Scraper] Failed to launch browser:', error);
        process.exit(1);
    }
}

async function gracefulShutdown() {
    console.log('[Scraper] Received shutdown signal. Closing browser...');
    if (browser) {
        await browser.close();
        console.log('[Scraper] Browser closed.');
    }
    process.exit(0);
}

function getBrowser() {
    if (!browser) throw new Error("Browser has not been initialized.");
    return browser;
}

async function extractVideoUrl(browser, url, referer = null) {
    const cacheKey = `video_url:${url}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
        console.log(`[Scraper] Cache hit for URL: ${url}`);
        return cached;
    }

    let context = null;
    try {
        context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });
        await context.route('**/*', route => ['image', 'stylesheet', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue());

        const page = await context.newPage();
        await page.setExtraHTTPHeaders({ 'Referer': referer || new URL(url).origin });
        await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 });

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
            if (videoUrl.endsWith('.mp4')) {
                try {
                    const response = await axios.head(videoUrl, { headers: { 'Referer': url }, timeout: 5000 });
                    const contentLength = response.headers['content-length'];
                    if (contentLength && parseInt(contentLength, 10) < 5 * 1024 * 1024) { // 5MB threshold
                        console.log(`[Scraper] Discarding placeholder video: ${videoUrl} (Size: ${contentLength} bytes)`);
                        return null;
                    }
                } catch (headError) {
                    console.warn(`[Scraper] Could not perform HEAD request for ${videoUrl}: ${headError.message}`);
                }
            }
            streamCache.set(cacheKey, videoUrl);
        }
        return videoUrl;
    } catch (error) {
        // Re-throw the error to be caught by the handler, ensuring the finally block still runs
        throw error;
    } finally {
        if (context) {
            await context.close();
        }
    }
}

module.exports = { startBrowser, gracefulShutdown, getBrowser, extractVideoUrl };
