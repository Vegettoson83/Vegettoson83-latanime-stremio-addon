const playwright = require('playwright');
const NodeCache = require('node-cache');

const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
let browser;

const PROVIDERS = {
    'yourupload.com': async (page) => {
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
    },
    'voe.sx': async (page) => {
        await page.waitForLoadState('networkidle');
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/let sources = (\{[^;]+\});/);
                if (match) {
                    try {
                        const sources = JSON.parse(match[1].replace(/'/g, '"'));
                        if (sources.hls) {
                            // Voe often uses a simple reverse string obfuscation
                            return sources.hls.split('').reverse().join('');
                        }
                        if (sources.src) {
                             return sources.src;
                        }
                    } catch (e) {
                        console.error('Failed to parse Voe sources', e);
                    }
                }
            }
            return null;
        });
    }
};

async function extractVideoUrl(context, url, referer = null) {
    const cacheKey = `video_url:${url}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
        console.log(`[Browser] Cache hit for final URL: ${url}`);
        return cached;
    }

    let page;
    try {
        page = await context.newPage();
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
        console.log('[Browser] Playwright browser launched successfully.');
    } catch (error) {
        console.error('[Browser] Failed to launch browser:', error);
        process.exit(1);
    }
}

async function gracefulShutdown() {
    console.log('[Browser] Received shutdown signal. Closing browser...');
    if (browser) {
        await browser.close();
        console.log('[Browser] Browser closed.');
    }
    process.exit(0);
}

function getBrowser() {
    if (!browser) {
        throw new Error("Browser has not been initialized.");
    }
    return browser;
}

module.exports = {
    extractVideoUrl,
    startBrowser,
    gracefulShutdown,
    getBrowser
};
