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

    static unpackJS(packed) {
        try {
            const args = packed.replace(/^['"]|['"]$/g, '').split(/,\s*/);
            if (args.length < 4) return '';

            let p = args[0].replace(/'/g, '');
            const a = parseInt(args[1]) || 10;
            const c = parseInt(args[2]) || 0;
            const k = args[3].replace(/["']/g, '').split('|');

            while (c--) {
                if (k[c]) {
                    const regex = new RegExp('\\b' + c.toString(a) + '\\b', 'g');
                    p = p.replace(regex, k[c]);
                }
            }
            return p;
        } catch (e) {
            return '';
        }
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
        /doubleclick|google-analytics|googletagmanager|pixel|track|analytics|telemetry|onesignal|cloudflare/i,
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
        const html = await page.content();
        let match = html.match(/'hls':\s*'([^']+)'/) ||
                    html.match(/"hls":\s*"([^"]+)"/) ||
                    html.match(/sources:\s*\{[^}]*hls:\s*'([^']+)'/);
        if (match) {
            try {
                const decoded = Buffer.from(match[1], 'base64').toString();
                if (decoded.startsWith('http')) return decoded;
            } catch (e) {}
            if (match[1].startsWith('http')) return match[1];
        }
        return page.evaluate(() => {
            const video = document.querySelector('video');
            return video?.src || video?.querySelector('source')?.src;
        });
    },
    'filemoon.sx': async (page) => {
        const html = await page.content();
        let match = html.match(/eval\(function\(p,a,c,k,e,d\).*?\}\((.*?)\)\)/s);
        if (match) {
            const decoded = Mahoraga.unpackJS(match[1]);
            const urlMatch = decoded.match(/file:"([^"]+)"/);
            if (urlMatch) return urlMatch[1];
        }
        return page.evaluate(() => {
            const video = document.querySelector('video');
            if (video?.src && !video.src.startsWith('blob:')) return video.src;
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const m = script.textContent.match(/file:\s*"([^"]+m3u8[^"]*)"/);
                if (m) return m[1];
            }
            return null;
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
        const url = page.url();
        const html = await page.content();
        const passMatch = html.match(/\/pass_md5\/([^'"\s]+)/);
        if (!passMatch) return null;

        const passUrl = `https://${new URL(url).hostname}/pass_md5/${passMatch[1]}`;
        const token = await page.evaluate(async (pUrl) => {
            const resp = await fetch(pUrl);
            return resp.text();
        }, passUrl);

        const randomStr = Array.from({length: 10}, () =>
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]
        ).join('');

        return `https://${new URL(url).hostname}${passMatch[1]}${randomStr}?token=${token}&expiry=${Date.now()}`;
    },
    'mixdrop': async (page) => {
        const html = await page.content();
        let match = html.match(/MDCore\.wurl\s*=\s*"([^"]+)"/) || html.match(/wurl\s*=\s*"([^"]+)"/);
        if (match) {
            try {
                const decoded = Buffer.from(match[1], 'base64').toString();
                return decoded.startsWith('//') ? 'https:' + decoded : (decoded.startsWith('http') ? decoded : null);
            } catch (e) {}
            return match[1].startsWith('//') ? 'https:' + match[1] : match[1];
        }
        return page.evaluate(() => document.querySelector('video')?.src);
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
        const html = await page.content();
        let match = html.match(/eval\(function\(p,a,c,k,e,d\).*?\}\((.*?)\)\)/s);
        if (match) {
            const decoded = Mahoraga.unpackJS(match[1]);
            const urlMatch = decoded.match(/file:"([^"]+)"/);
            if (urlMatch) return urlMatch[1];
        }
        return page.evaluate(() => {
            const video = document.querySelector('video');
            return video?.src || video?.querySelector('source')?.src;
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
        const html = await page.content();
        const packed = html.match(/eval\(function\(p,a,c,k,e,d\).*?\}\((.*?)\)\)/s);
        if (packed) {
            const decoded = Mahoraga.unpackJS(packed[1]);
            const urlMatch = decoded.match(/file:"([^"]+)"/);
            if (urlMatch) return urlMatch[1];
        }
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
        const url = page.url().replace('/e/', '/v/');
        if (url !== page.url()) await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});

        const html = await page.content();
        const norobotMatch = html.match(/getElementById\('norobotlink'\)\.innerHTML = (.+?);/);
        const linkMatch = html.match(/id\s*=\s*["']ideoooolink["'][^>]*>([^<]+)</);

        if (norobotMatch && linkMatch) {
            const tokenMatch = norobotMatch[1].match(/token=([^&']+)/);
            if (tokenMatch) {
                return `https:/${linkMatch[1].trim()}&token=${tokenMatch[1]}&stream=1`;
            }
        }
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'streamwish.to': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'vidmoly.to': async (page) => {
        const html = await page.content();
        const packed = html.match(/eval\(function\(p,a,c,k,e,d\).*?\}\((.*?)\)\)/s);
        if (packed) {
            const decoded = Mahoraga.unpackJS(packed[1]);
            const urlMatch = decoded.match(/file:"([^"]+)"/);
            if (urlMatch) return urlMatch[1];
        }
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'vidoza.net': async (page) => {
        const html = await page.content();
        const match = html.match(/src:\s*"([^"]+\.mp4[^"']*)"/);
        if (match) return match[1];
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'supervideo.tv': async (page) => {
        const html = await page.content();
        const packed = html.match(/eval\(function\(p,a,c,k,e,d\).*?\}\((.*?)\)\)/s);
        if (packed) {
            const decoded = Mahoraga.unpackJS(packed[1]);
            const urlMatch = decoded.match(/file:"([^"]+)"/);
            if (urlMatch) return urlMatch[1];
        }
        return page.evaluate(() => document.querySelector('video')?.src);
    },
    'upstream.to': async (page) => {
        const html = await page.content();
        const match = html.match(/file:\s*"([^"]+\.m3u8[^"']*)"/);
        if (match) return match[1];
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
            } else if (reqUrl.includes('.mp4') || reqUrl.includes('.m3u8')) {
                // Log why it was rejected
                // console.log(`[Mahoraga] 👁️ Potential stream rejected: ${reqUrl.substring(0, 80)}...`);
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
            async (p) => {
                const scripts = await p.evaluate(() => Array.from(document.querySelectorAll('script')).map(s => s.textContent));
                for (const script of scripts) {
                    // Check for common video URL patterns
                    const match = script.match(/https?:\/\/[^\s"']+\.(?:m3u8|mp4)[^\s"']*/);
                    if (match && isValidStreamUrl(match[0])) return match[0];

                    // Check for packed JS in ANY script as a fallback
                    const packed = script.match(/eval\(function\(p,a,c,k,e,d\).*?\}\((.*?)\)\)/s);
                    if (packed) {
                        const decoded = Mahoraga.unpackJS(packed[1]);
                        const urlMatch = decoded.match(/file:"([^"]+)"/) || decoded.match(/src:"([^"]+)"/);
                        if (urlMatch && isValidStreamUrl(urlMatch[1])) return urlMatch[1];
                    }
                }
                return null;
            },
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
        const batchSize = 4;
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
