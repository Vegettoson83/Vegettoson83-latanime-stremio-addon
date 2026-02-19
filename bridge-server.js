const express = require('express');
const playwright = require('playwright');
const NodeCache = require('node-cache');
const cheerio = require('cheerio');
const { fetchWithScrapingBee } = require('./lib/scraping');

const app = express();
app.use(express.json());

const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
let browser;

function isValidStreamUrl(url) {
    if (!url || typeof url !== 'string' || url.startsWith('blob:')) return false;

    // Explicitly exclude non-video assets
    if (url.match(/\.(js|css|png|jpg|jpeg|gif|woff|woff2|svg|json)(\?.*)?$/i)) return false;

    const adPattern = /[/_-]ad([/_-]|$)|[?&]ad=|static\.doubleclick\.net|google-analytics\.com|rocket-loader|popads|onclick|syndication\.com|a\.nested/i;
    if (adPattern.test(url)) return false;

    const videoExtensions = /\.(mp4|m3u8|mkv|webm|ts|mov|avi)(\?.*)?$/i;
    const isDirectVideo = videoExtensions.test(url);

    const streamKeywords = [
        'm3u8', 'googleusercontent.com', 'storage.googleapis.com',
        '/video.mp4', 'video.mp4', 'manifest.mpd', '.mp4?', '.m3u8?', 'playlist', 'master.m3u8',
        'okcdn.ru', 'vk.com/video_ext.php', '/pass/', '/stream/', '/hls/', 'bitmovin', 'clouddn',
        'mega.nz/embed'
    ];
    // Strict check for .mp4 to avoid matching domain names like mp4upload.com
    const hasStrictVideoPattern = /\.(mp4|m3u8|mpd|ts)(\/|\?|$)/i.test(url);
    const hasStreamKeyword = streamKeywords.some(keyword => url.toLowerCase().includes(keyword.toLowerCase())) || hasStrictVideoPattern;

    const embedPagePattern = /(embed|player|iframe|\/v\/|\/e\/)/i;
    // An embed page URL like host.com/embed/123 is not a direct stream unless it ends with a video extension
    const isLikelyEmbedPage = embedPagePattern.test(url) && !isDirectVideo;

    if (isDirectVideo) return true;
    if (hasStreamKeyword && !isLikelyEmbedPage) return true;

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
    'listeamed': async (page) => {
        await page.waitForTimeout(5000);
        return null;
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
    'dsvplay.com': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const video = document.querySelector('video');
            if (video?.src && !video.src.startsWith('blob:')) return video.src;
            const source = document.querySelector('video source');
            return source?.src || null;
        });
    },
    'mega.nz': async (page) => {
        // Mega.nz embeds are hard to scrape for direct links, so we return the embed URL itself as a fallback
        return page.url();
    }
};

async function extractVideoUrl(context, url, referer = null) {
    const cacheKey = `video_url:${url}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
        console.log(`[Bridge] Cache hit for final URL: ${url}`);
        return cached;
    }

    let page;
    try {
        page = await context.newPage();
        await page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': referer || new URL(url).origin,
        });

        let videoUrl = null;
        page.on('request', request => {
            const reqUrl = request.url();
            if (isValidStreamUrl(reqUrl) && !videoUrl) {
                console.log(`[Bridge] 🎯 Potential video URL detected via network: ${reqUrl.substring(0, 100)}...`);
                videoUrl = reqUrl;
            }
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

        // Wait up to 3s for initial network detection (reduced from 5s)
        let checkCount = 0;
        while (!videoUrl && checkCount < 6) {
            await new Promise(r => setTimeout(r, 500));
            checkCount++;
        }

        // If still no video, try the specific extractor first as it's often faster/more reliable than generic triggers
        if (!videoUrl) {
            const detectedProvider = Object.keys(PROVIDERS).find(p => url.includes(p));
            const extractor = detectedProvider ? PROVIDERS[detectedProvider] : null;

            if (extractor) {
                videoUrl = await extractor(page).catch(e => {
                    console.error(`[Bridge] Extractor error for ${url}: ${e.message}`);
                    return null;
                });
            }
        }

        // If still not found, try generic evaluation or clicking to trigger play
        if (!videoUrl) {
            videoUrl = await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video?.src && !video.src.startsWith('blob:')) return video.src;
                const source = document.querySelector('video source');
                if (source?.src) return source.src;
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const script of scripts) {
                    const match = script.textContent.match(/https?:\/\/[^\s"']+\.(?:m3u8|mp4)[^\s"']*/);
                    if (match) return match[0];
                }
                return null;
            }).catch(() => null);
        }

        // Only try clicking as a last resort
        if (!videoUrl) {
            console.log(`[Bridge] No video found yet for ${url}, attempting to trigger play...`);
            const playButtonSelectors = [
                'div.play-button', 'button.vjs-big-play-button', '.jw-display-icon-container',
                'button[aria-label*="Play"]', '#start', '#vplayer', 'video', 'body'
            ];
            for (const selector of playButtonSelectors) {
                if (videoUrl) break;
                try {
                    const exists = await page.evaluate((sel) => !!document.querySelector(sel), selector).catch(() => false);
                    if (!exists) continue;

                    await page.click(selector, { timeout: 2000 }).catch(() => {});
                    let innerCheck = 0;
                    while (!videoUrl && innerCheck < 4) {
                        await new Promise(r => setTimeout(r, 500));
                        innerCheck++;
                    }
                } catch (e) {
                    if (e.message.includes('context was destroyed')) break;
                }
            }
        }

        if (videoUrl && isValidStreamUrl(videoUrl)) {
            streamCache.set(cacheKey, videoUrl);
            return videoUrl;
        } else if (videoUrl) {
            console.log(`[Bridge] ⚠️ Invalid stream URL detected or rejected for ${url}: ${videoUrl}`);
        } else {
            console.log(`[Bridge] ❌ No video URL found for ${url}`);
        }
        return null;
    } finally {
        if (page) {
            await page.close().catch(() => {});
        }
    }
}

app.post('/scrape', async (req, res) => {
    const { url } = req.body;
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
                    let directUrl;
                    try {
                        const decoded = Buffer.from(encodedPart, 'base64').toString();
                        if (decoded.startsWith('http')) {
                            directUrl = decoded;
                        }
                    } catch (e) {}

                    const intermediateUrl = directUrl || (basePlayerUrl + encodedPart);
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
                let finalUrl = null;
                // If the provider.url is already a direct link (decoded from data-player), skip the reproductor logic
                if (provider.url.startsWith('http') && !provider.url.includes('latanime.org/reproductor')) {
                    finalUrl = provider.url;
                }

                if (!finalUrl) {
                    providerPage = await context.newPage();
                    await providerPage.route('**/*', (route) => {
                        if (['image', 'stylesheet', 'font'].includes(route.request().resourceType())) {
                            route.abort();
                        } else {
                            route.continue();
                        }
                    });

                    await providerPage.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

                    finalUrl = await providerPage.evaluate(() => {
                        const redirMatch = document.body.innerHTML.match(/var redir = atob\("([^"]+)"\);/);
                        return redirMatch ? atob(redirMatch[1]) : null;
                    }).catch(() => null);

                    // If no redir found, and it's not the reproductor, assume provider.url is the final embed URL
                    if (!finalUrl && !provider.url.includes('latanime.org/reproductor')) {
                        finalUrl = provider.url;
                    }
                }

                if (finalUrl) {
                    console.log(`[Bridge] Found final embed for ${provider.title}: ${finalUrl}`);
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
        const batchSize = 5;
        for (let i = 0; i < providers.length; i += batchSize) {
            const batch = providers.slice(i, i + batchSize);
            await Promise.all(batch.map(p => processProvider(p)));
        }

        const downloadLinks = [];
        const dlSelectors = [
            'a[href*="pixeldrain.com"]', 'a[href*="mediafire.com"]', 'a[href*="mega.nz"]',
            'a[href*="gofile.io"]', 'a[href*="drive.google.com"]', 'a[href*="1fichier.com"]',
            'a[download]'
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

app.listen(port, async () => {
    await startBrowser();
    console.log(`[Bridge] Server listening on port ${port}`);
});
