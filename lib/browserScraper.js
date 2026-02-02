const NodeCache = require('node-cache');
const axios = require('axios');

const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

const PROVIDERS = {
    'filemoon.sx': async (page) => {
        await page.waitForTimeout(5000);

        const packedScriptContent = await page.evaluate(() => {
            const script = Array.from(document.querySelectorAll('script')).find(s => s.textContent.includes('eval(function(p,a,c,k,e,d)'));
            return script ? script.textContent : null;
        });

        if (packedScriptContent) {
            try {
                const deobfuscate = (p, a, c, k, e, d) => {
                    k = k.split('|');
                    e = (c) => { return (c < a ? '' : e(parseInt(c / a))) + ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36)) };
                    if (!''.replace(/^/, String)) {
                        while (c--) { d[e(c)] = k[c] || e(c) }
                        k = [(e) => { return d[e] }];
                        e = () => { return '\\w+' };
                        c = 1;
                    };
                    while (c--) {
                        if (k[c]) { p = p.replace(new RegExp('\\b' + e(c) + '\\b', 'g'), k[c]) }
                    }
                    return p;
                };

                const paramsMatch = packedScriptContent.match(/eval\(function\(p,a,c,k,e,d\)\{.*return p\}\('(.*)',(\d+),(\d+),'(.*)'\.split\('\|'\),(\d+),{}\)\)/);
                if (paramsMatch) {
                    const [_, p, a, c, k, e] = paramsMatch;
                    const deobfuscated = deobfuscate(p, parseInt(a), parseInt(c), k, parseInt(e), {});
                    const urlMatch = deobfuscated.match(/file:"(https?:\/\/[^"]+master\.m3u8[^"]*)"/);
                    if (urlMatch) return urlMatch[1];
                }
            } catch (e) {
                console.error('[Filemoon] Error during deobfuscation:', e.message);
            }
        }

        return page.evaluate(() => {
            if (typeof jwplayer === 'function' && jwplayer().getConfig()) {
                const sources = jwplayer().getConfig().sources;
                if (sources && sources.length > 0) return sources[0].file;
            }
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/(https?:\/\/[^"']+\/master\.m3u8[^"']*)/);
                if (match) return match[0];
            }
            return null;
        });
    },
    'dsvplay.com': async (page) => {
        await page.waitForTimeout(5000); // Allow more time for scripts
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                // Look for jwplayer setup with m3u8 source
                const match = script.textContent.match(/sources:\s*\[{\s*file:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
                if (match) return match[1];

                // Alternative pattern
                const altMatch = script.textContent.match(/file:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
                if (altMatch) return altMatch[1];
            }
            return document.querySelector('video source')?.src || document.querySelector('video')?.src;
        });
    },
    'uqload.com': async (page) => {
        await page.waitForTimeout(5000);
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/sources:\s*\[\s*{\s*file:\s*"(https?:\/\/[^"]+)"/);
                if (match) return match[1];
            }
            return document.querySelector('video source')?.src || document.querySelector('video')?.src;
        });
    },
    'voe.sx': async (page) => {
        await page.waitForTimeout(6000); // Voe can be slow to load
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/'hls':\s*'(https?:\/\/[^']+\.m3u8)'/);
                if (match) return match[1];
            }
            // Fallback for direct video tags
            return document.querySelector('video source')?.src || document.querySelector('video')?.src;
        });
    },
    'mp4upload.com': async (page) => {
        await page.waitForSelector('#player', { timeout: 15000 });
        await page.waitForTimeout(3000); // Allow player scripts to load
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
             for (const script of scripts) {
                const match = script.textContent.match(/player\.src\("([^"]+\.mp4[^"]*)"\)/);
                if (match) return match[1];
            }
            // Fallback for direct video tags
            return document.querySelector('video source')?.src || document.querySelector('video')?.src;
        });
    },
    'yourupload.com': async (page) => {
        await page.waitForSelector('video', { timeout: 15000 });
        return page.evaluate(() => document.querySelector('video source')?.src || document.querySelector('video')?.src);
    },
    'mega.nz': () => null, // Placeholder
    'luluvid.com': async (page) => page.evaluate(() => document.querySelector('video source')?.src || document.querySelector('video')?.src),
    'mxdrop.to': async (page) => page.evaluate(() => document.querySelector('video source')?.src || document.querySelector('video')?.src),
    'vidsrc.to': async (page) => page.evaluate(() => document.querySelector('video source')?.src || document.querySelector('video')?.src)
};

async function extractVideoUrl(getBrowser, proxyUrl, referer = null) {
    const cacheKey = `video_url:${proxyUrl}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
        console.log(`[Scraper] Cache hit for URL: ${proxyUrl}`);
        return cached;
    }

    let context = null;
    try {
        const browser = getBrowser();
        context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        });

        await context.route('**/*', (route) => {
            if (['image', 'stylesheet', 'font'].includes(route.request().resourceType())) {
                route.abort();
            } else {
                route.continue();
            }
        });

        const page = await context.newPage();
        await page.setExtraHTTPHeaders({ 'Referer': referer || new URL(proxyUrl).origin });

        await page.goto(proxyUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        const iframeLocator = page.locator('iframe').first();
        await iframeLocator.waitFor({ timeout: 30000 });
        const finalUrl = await iframeLocator.getAttribute('src');

        if (!finalUrl) throw new Error("Could not find iframe source in proxy page.");

        console.log(`[Scraper] Navigated proxy. Final provider URL: ${finalUrl.substring(0, 60)}...`);

        await page.goto(finalUrl, { waitUntil: 'networkidle', timeout: 40000 });
        const url = finalUrl;

        const detectedProvider = Object.keys(PROVIDERS).find(p => url.includes(p));
        const extractor = detectedProvider ? PROVIDERS[detectedProvider] : null;

        let videoUrl;
        if (extractor) {
            videoUrl = await extractor(page);
        } else {
            videoUrl = await page.evaluate(() => {
                const video = document.querySelector('video');
                return video?.src || video?.querySelector('source')?.src;
            });
        }

        if (videoUrl) {
            if (videoUrl.endsWith('.mp4')) {
                try {
                    const response = await axios.head(videoUrl, { headers: { 'Referer': url }, timeout: 5000 });
                    const contentLength = parseInt(response.headers['content-length'], 10);
                    if (contentLength < 5 * 1024 * 1024) {
                        console.log(`[Scraper] Discarding placeholder video: ${videoUrl} (Size: ${contentLength} bytes)`);
                        return null;
                    }
                } catch (headError) {
                    console.warn(`[Scraper] HEAD request failed for ${videoUrl}: ${headError.message}`);
                }
            }
            streamCache.set(cacheKey, videoUrl);
        }
        return videoUrl;
    } catch (error) {
        console.error(`[Scraper] Error scraping ${proxyUrl}: ${error.message}`);
        return null;
    } finally {
        if (context) {
            await context.close();
        }
    }
}

module.exports = { extractVideoUrl, PROVIDERS };
