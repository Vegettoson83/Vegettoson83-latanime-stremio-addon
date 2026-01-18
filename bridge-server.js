const express = require('express');
const playwright = require('playwright');
const NodeCache = require('node-cache');
const cheerio = require('cheerio');
const { fetchWithScrapingBee } = require('./lib/scraping');

const app = express();
app.use(express.json());

const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
let browser;

/**
 * MAHORAGA ADAPTATION ENGINE v1.0
 * Implementation of the Adaptive Intelligence Framework for Stream Extraction.
 */
class Mahoraga {
    constructor(url) {
        this.url = url;
        this.rotation = 0;
        this.phenomena = [];
        this.adapted = false;
        this.masteredUrl = null;
    }

    async turnWheel(page, strategies) {
        console.log(`[Mahoraga] Turning the wheel... Rotation: ${++this.rotation} for ${this.url}`);
        for (const strategy of strategies) {
            try {
                const result = await strategy(page);
                if (result && isValidStreamUrl(result)) {
                    console.log(`[Mahoraga] ✅ Adaptation complete. Phenomenon mastered.`);
                    this.adapted = true;
                    this.masteredUrl = result;
                    return result;
                }
            } catch (e) {
                console.error(`[Mahoraga] Rotation ${this.rotation} failed strategy: ${e.message}`);
            }
        }
        return null;
    }
}

/**
 * SAITAMA ONE PUNCH VALIDATOR v1.0
 * Definitive filtering logic to identify valid video streams and eliminate ad-noise.
 */
function isValidStreamUrl(url) {
    if (!url || typeof url !== 'string' || url.startsWith('blob:')) return false;

    // Negative constraints (Force escape from ad-noise)
    const blacklistedAssets = /\.(js|css|png|jpg|jpeg|gif|woff|woff2|svg|json|html|php|aspx|txt|xml)(\?.*)?$/i;
    if (blacklistedAssets.test(url)) return false;

    const adNoisePatterns = [
        /[/_-]ad([/_-]|$)|[?&]ad=/i,
        /doubleclick|google-analytics|googletagmanager|pixel|track|analytics|telemetry|onesignal/i,
        /cloudflare-static|rocket-loader/i,
        /license|popunder|onclick/i,
        /test-videos\.co\.uk/i
    ];
    if (adNoisePatterns.some(p => p.test(url))) return false;

    // Positive constraints (Identify the One True Stream)
    const directVideoExtensions = /\.(mp4|m3u8|mkv|webm|ts|mov|avi|mpd)(\/|\?|$)/i;
    if (directVideoExtensions.test(url)) return true;

    const highConfidenceHosts = [
        'googleusercontent.com',
        'storage.googleapis.com',
        'googlevideo.com',
        'okcdn.ru',
        'vk.com/video_ext.php'
    ];
    if (highConfidenceHosts.some(h => url.includes(h))) return true;

    const streamKeywords = ['/video.mp4', 'video.mp4', 'playlist', 'master.m3u8', 'chunk'];
    if (streamKeywords.some(k => url.toLowerCase().includes(k))) {
        // Prevent matching hostnames or embed pages as streams
        const isEmbedPage = /(embed|player|iframe|\/v\/|\/e\/)/i.test(url);
        return !isEmbedPage;
    }

    return false;
}

const PROVIDERS = {
    'yourupload.com': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const video = document.querySelector('video');
            if (video?.src && !video.src.startsWith('blob:')) return video.src;
            const source = document.querySelector('video source');
            if (source?.src) return source.src;
            return null;
        });
    },
    'mp4upload.com': async (page) => {
        await page.waitForSelector('video', { state: 'visible', timeout: 20000 }).catch(() => {});
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match1 = script.textContent.match(/player\.src\("([^"]+)"\)/);
                if (match1) return match1[1];
                const match2 = script.textContent.match(/https?:\/\/[^"']+\.(mp4|m3u8)[^"']*/);
                if (match2) return match2[0];
            }
            const video = document.querySelector('video');
            return video?.src || video?.querySelector('source')?.src;
        });
    },
    'voe.sx': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/'hls':\s*'([^']+)'/) ||
                              script.textContent.match(/"hls":\s*"([^"]+)"/) ||
                              script.textContent.match(/mp4':\s*'([^']+)'/);
                if (match) return match[1];
            }
            const video = document.querySelector('video');
            return video?.src || video?.querySelector('source')?.src;
        });
    },
    'filemoon.sx': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/file:\s*"([^"]+m3u8[^"]*)"/);
                if (match) return match[1];
            }
            return document.querySelector('video')?.src;
        });
    },
    'ok.ru': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const video = document.querySelector('video');
            if (video?.src && !video.src.startsWith('blob:')) return video.src;
            const meta = document.querySelector('div[data-options]');
            if (meta) {
                try {
                    const options = JSON.parse(meta.getAttribute('data-options'));
                    const metadata = JSON.parse(options.flashvars.metadata);
                    const streams = metadata.videos;
                    if (streams && streams.length > 0) {
                        return streams[streams.length - 1].url; // Highest quality
                    }
                } catch (e) {}
            }
            return null;
        });
    },
    'doodstream.com': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const video = document.querySelector('video');
            if (video?.src && !video.src.startsWith('blob:')) return video.src;
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/https?:\/\/[^"']+\.(?:mp4|m3u8|webm)[^"']*/);
                if (match) return match[0];
            }
            return null;
        });
    },
    'mixdrop': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const video = document.querySelector('video');
            if (video?.src && !video.src.startsWith('blob:')) return video.src;
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/MDCore\.wurl\s*=\s*"([^"]+)"/);
                if (match) return match[1].startsWith('//') ? 'https:' + match[1] : match[1];
            }
            return null;
        });
    },
    'uqload': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/sources:\s*\["([^"]+)"\]/);
                if (match) return match[1];
            }
            const video = document.querySelector('video');
            return video?.src || video?.querySelector('source')?.src;
        });
    },
    'luluvdo': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/file:\s*"([^"]+m3u8[^"]*)"/);
                if (match) return match[1];
            }
            return document.querySelector('video')?.src;
        });
    },
    'lulu': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'vidply': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'myvidplay': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'fembed': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'mxdrop': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'm1xdrop': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'dsvplay.com': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'savefiles.com': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'mega.nz': async (page) => {
        await page.waitForTimeout(5000);
        return null; // Rely on network interception for mega
    },
    'listeamed': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'vidsrc': async (page) => {
        await page.waitForSelector('iframe', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const match = script.textContent.match(/https?:\/\/[^"']+\.m3u8[^"']*/);
                if (match) return match[0];
            }
            return null;
        });
    },
    'wolfstream': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'lvturbo': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'sendvid.com': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'streamtape.com': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'streamwish.to': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'vidmoly.to': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    }
};

async function extractVideoUrl(context, url, referer = null) {
    const cacheKey = `video_url:${url}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
        console.log(`[Bridge] Cache hit for final URL: ${url}`);
        return cached;
    }

    const mahoraga = new Mahoraga(url);
    let page;
    try {
        page = await context.newPage();
        await page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': referer || new URL(url).origin,
        });

        let videoUrl = null;
        page.on('request', request => {
            const reqUrl = request.url();
            if (isValidStreamUrl(reqUrl) && !videoUrl) {
                console.log(`[Mahoraga] 👁️ Phenomenon Detected (Network): ${reqUrl.substring(0, 80)}...`);
                videoUrl = reqUrl;
            }
        });

        // ROTATION 1: PASSIVE OBSERVATION
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

        let waitCount = 0;
        while (!videoUrl && waitCount < 10) {
            await new Promise(r => setTimeout(r, 500));
            waitCount++;
        }

        if (videoUrl) return mahoraga.turnWheel(page, [() => videoUrl]);

        // ROTATION 2: ACTIVE ENGAGEMENT (Pattern Matching & Interaction)
        const strategies = [
            // Strategy: Provider-specific Mastery
            async (p) => {
                const detectedProvider = Object.keys(PROVIDERS).find(key => url.includes(key));
                return detectedProvider ? PROVIDERS[detectedProvider](p) : null;
            },
            // Strategy: DOM Scavenging
            async (p) => p.evaluate(() => {
                const video = document.querySelector('video');
                if (video?.src && !video.src.startsWith('blob:')) return video.src;
                const source = document.querySelector('video source');
                return source?.src || null;
            }),
            // Strategy: Trigger Engagement (The "Sandal-Hat" Approach)
            async (p) => {
                const selectors = ['div.play-button', 'button.vjs-big-play-button', '.jw-display-icon-container', '#vplayer', 'video', 'body'];
                for (const selector of selectors) {
                    if (videoUrl) break;
                    try {
                        const exists = await p.evaluate((sel) => !!document.querySelector(sel), selector).catch(() => false);
                        if (exists) {
                            await p.click(selector, { timeout: 2000 }).catch(() => {});
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    } catch (e) {}
                }
                return videoUrl;
            },
            // Strategy: Script Archeology
            async (p) => p.evaluate(() => {
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const script of scripts) {
                    const match = script.textContent.match(/https?:\/\/[^\s"']+\.(?:m3u8|mp4)[^\s"']*/);
                    if (match) return match[0];
                }
                return null;
            }),
            // Strategy: Patience (Last Resort)
            async (p) => {
                await new Promise(r => setTimeout(r, 5000));
                return videoUrl;
            }
        ];

        videoUrl = await mahoraga.turnWheel(page, strategies);

        if (videoUrl && isValidStreamUrl(videoUrl)) {
            console.log(`[RECURSION-COMPLETE] Extracted valid stream: ${videoUrl.substring(0, 80)}...`);
            streamCache.set(cacheKey, videoUrl);
            return videoUrl;
        }

        console.log(`[Mahoraga] ❌ Failed to adapt to ${url}. Phenomenon remains elusive.`);
        return null;
    } finally {
        if (page) {
            await page.close().catch(() => {});
        }
    }
}

app.post('/scrape', async (req, res) => {
    const { url } = req.body;
    console.log(`[STATE-SCRAPE] request: ${url}`);
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    if (!browser || !browser.isConnected()) {
        console.log('[Bridge] Browser not initialized or disconnected, restarting...');
        await startBrowser();
    }

    let context;
    try {
        console.log(`[Bridge] Scraping latanime page via ScrapingBee: ${url}`);
        const html = await fetchWithScrapingBee(url, true);
        const $ = cheerio.load(html);

        const providers = [];
        const baseKey = $('div.player').attr('data-key');
        if (baseKey) {
            const basePlayerUrl = Buffer.from(baseKey, 'base64').toString();
            $('a.play-video').each((i, el) => {
                const providerName = $(el).text().trim();
                const encodedPart = $(el).attr('data-player');
                if (encodedPart) {
                    const intermediateUrl = providerName.toLowerCase() === 'yourupload' ? Buffer.from(encodedPart, 'base64').toString() : basePlayerUrl + encodedPart;
                    providers.push({ url: intermediateUrl, title: providerName });
                }
            });
        }

        console.log(`[Bridge] Found ${providers.length} potential providers.`);
        context = await browser.newContext();

        const resolvedStreams = [];
        const processProvider = async (provider) => {
            if (!browser || !browser.isConnected()) return;
            let providerPage = null;
            try {
                providerPage = await context.newPage();
                await providerPage.route('**/*', (route) => {
                    if (['image', 'stylesheet', 'font'].includes(route.request().resourceType())) {
                        route.abort();
                    } else {
                        route.continue();
                    }
                });

                await providerPage.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

                const finalUrl = await providerPage.evaluate(() => {
                    const redirMatch = document.body.innerHTML.match(/var redir = atob\("([^"]+)"\);/);
                    return redirMatch ? atob(redirMatch[1]) : null;
                }).catch(() => null);

                if (finalUrl) {
                    console.log(`[Bridge] Found final embed for ${provider.title}`);
                    const videoUrl = await extractVideoUrl(context, finalUrl, provider.url);
                    if (videoUrl) {
                        console.log(`[Bridge] ✅ Extracted: ${provider.title}`);
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
                console.error(`[Bridge] Error processing ${provider.title}: ${e.message}`);
            } finally {
                if (providerPage) await providerPage.close().catch(() => {});
            }
        };

        // Process in concurrent batches
        const batchSize = 3;
        for (let i = 0; i < providers.length; i += batchSize) {
            const batch = providers.slice(i, i + batchSize);
            await Promise.all(batch.map(p => processProvider(p)));
        }

        const downloadLinks = [];
        const dlSelectors = [
            'a[href*="pixeldrain.com"]', 'a[href*="mediafire.com"]', 'a[href*="mega.nz"]',
            'a[href*="gofile.io"]', 'a[href*="drive.google.com"]', 'a[href*="1fichier.com"]',
            'a[href*="1cloudfile.com"]', 'a[download]'
        ];
        $(dlSelectors.join(',')).each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                downloadLinks.push({ url: href, title: `📥 ${$(el).text().trim() || 'Download'}` });
            }
        });

        const allStreams = [...resolvedStreams, ...downloadLinks];
        console.log(`[Bridge] Total streams found: ${allStreams.length}`);
        res.json({ streams: allStreams });

    } catch (error) {
        console.error(`[Bridge] Scraping error on ${url}: ${error.message}`);
        res.status(500).json({ error: 'Scraping failed', streams: [] });
    } finally {
        if (context) {
            await context.close().catch(() => {});
        }
    }
});

const port = process.env.BRIDGE_PORT || 3001;

async function startBrowser() {
    try {
        if (browser && browser.isConnected()) return;
        browser = await playwright.chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
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

if (require.main === module) {
    app.listen(port, async () => {
        await startBrowser();
        console.log(`[Bridge] Server listening on port ${port}`);
    });
}

module.exports = { isValidStreamUrl };
