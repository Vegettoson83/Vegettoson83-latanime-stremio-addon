const cheerio = require("cheerio");
const axios = require("axios");
const NodeCache = require("node-cache");
const {
    LATANIME_URL,
    ITEMS_PER_PAGE,
    fetchWithScrapingBee,
    normalizeId
} = require("./scraping");

const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

function isValidStreamUrl(url) {
    if (!url || typeof url !== 'string' || url.startsWith('blob:')) return false;
    if (url.match(/\.(js|css|png|jpg|jpeg|gif|woff|woff2|svg|json)(\?.*)?$/i)) return false;
    const adPattern = /[/_-]ad([/_-]|$)|static\.doubleclick\.net|google-analytics\.com|rocket-loader/i;
    if (adPattern.test(url)) return false;
    const videoExtensions = /\.(mp4|m3u8|mkv|webm|ts|mov|avi)(\?.*)?$/i;
    const isDirectVideo = videoExtensions.test(url);
    const streamKeywords = [
        'm3u8', 'googleusercontent.com', 'storage.googleapis.com',
        '/video.mp4', 'video.mp4', 'manifest.mpd', '.mp4?', '.m3u8?', 'playlist', 'master.m3u8',
        'okcdn.ru', 'vk.com/video_ext.php'
    ];
    const hasStrictVideoPattern = /\.(mp4|m3u8|mpd|ts)(\/|\?|$)/i.test(url);
    const hasStreamKeyword = streamKeywords.some(keyword => url.toLowerCase().includes(keyword.toLowerCase())) || hasStrictVideoPattern;
    const embedPagePattern = /(embed|player|iframe|\/v\/|\/e\/)/i;
    const isLikelyEmbedPage = embedPagePattern.test(url) && !isDirectVideo;
    if (isDirectVideo) return true;
    if (hasStreamKeyword && !isLikelyEmbedPage) return true;
    return false;
}

const PROVIDERS = {
    'yourupload.com': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => (document.querySelector('video')?.src.startsWith('blob:') ? document.querySelector('video source')?.src : document.querySelector('video')?.src));
    },
    'mp4upload.com': async (page) => {
        await page.waitForSelector('video', { state: 'visible', timeout: 20000 }).catch(() => {});
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/player\.src\("([^"]+)"\)|https?:\/\/[^"']+\.(mp4|m3u8)[^"']*/);
                if (match) return match[1] || match[0];
            }
            return document.querySelector('video')?.src || document.querySelector('video source')?.src;
        });
    },
    'voe.sx': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const match = script.textContent.match(/'hlsUrl'\s*:\s*'([^']+)'/);
                if (match) return match[1];
            }
            return document.querySelector('video')?.src || document.querySelector('video source')?.src;
        });
    },
    'filemoon.sx': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                if (script.textContent.includes('eval(function(p,a,c,k,e,d)')) {
                    const packedCode = script.textContent;
                    try {
                        const unpacked = eval(packedCode.replace('eval', ''));
                        const match = unpacked.match(/file:\s*"([^"]+m3u8[^"]*)"/);
                        if (match) return match[1];
                    } catch (e) {
                        // console.error('Eval failed', e);
                    }
                }
            }
            return null;
        });
    },
    'ok.ru': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            try {
                const options = JSON.parse(document.querySelector('div[data-options]').getAttribute('data-options'));
                const streams = JSON.parse(options.flashvars.metadata).videos;
                return streams[streams.length - 1].url;
            } catch (e) {
                return document.querySelector('video')?.src;
            }
        });
    },
    'doodstream.com': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const match = document.body.innerHTML.match(/https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*/);
            return match ? match[0] : document.querySelector('video')?.src;
        });
    },
    'mixdrop': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const match = document.body.innerHTML.match(/MDCore\.wurl\s*=\s*"([^"]+)"/);
            return match ? (match[1].startsWith('//') ? 'https:' + match[1] : match[1]) : document.querySelector('video')?.src;
        });
    },
    'uqload': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const match = document.body.innerHTML.match(/sources:\s*\["([^"]+)"\]/);
            return match ? match[1] : document.querySelector('video')?.src;
        });
    },
    'luluvdo': async (page) => (await PROVIDERS['filemoon.sx'](page)),
    'lulu': async (page) => (await page.evaluate(() => document.querySelector('video')?.src)),
    'vidply': async (page) => (await page.evaluate(() => document.querySelector('video')?.src)),
    'myvidplay': async (page) => (await page.evaluate(() => document.querySelector('video')?.src)),
    'fembed': async (page) => (await page.evaluate(() => document.querySelector('video')?.src)),
    'mxdrop': async (page) => (await page.evaluate(() => document.querySelector('video')?.src)),
    'm1xdrop': async (page) => (await page.evaluate(() => document.querySelector('video')?.src)),
    'wolfstream': async (page) => (await page.evaluate(() => document.querySelector('video')?.src)),
    'lvturbo': async (page) => (await page.evaluate(() => document.querySelector('video')?.src)),
    'dsvplay.com': async (page) => (await PROVIDERS['streamtape.com'](page)),
    'streamtape.com': async (page) => {
        await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
        return page.evaluate(() => {
            const robotLink = document.getElementById('robotlink');
            if (robotLink) {
                const urlPart = robotLink.innerHTML;
                const match = urlPart.match(/\/\/streamtape\.com\/get_video\?[^']+/);
                if (match) {
                    return 'https:' + match[0];
                }
            }
            const video = document.querySelector('video');
            return video?.src || video?.querySelector('source')?.src;
        });
    },
};

async function extractVideoUrl(context, url, referer = null) {
    const cacheKey = `video_url:${url}`;
    if (streamCache.has(cacheKey)) {
        console.log(`[Cache] Hit for final URL: ${url}`);
        return streamCache.get(cacheKey);
    }

    let page;
    try {
        page = await context.newPage();
        await page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': referer || new URL(url).origin,
        });

        let videoUrl = null;
        page.on('request', request => {
            const reqUrl = request.url();
            if (isValidStreamUrl(reqUrl) && !videoUrl) {
                console.log(`[Handler] Potential video URL detected via network: ${reqUrl.substring(0, 100)}...`);
                videoUrl = reqUrl;
            }
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

        let checkCount = 0;
        while (!videoUrl && checkCount < 10) {
            await new Promise(r => setTimeout(r, 500));
            checkCount++;
        }

        if (!videoUrl) {
            console.log(`[Handler] No video found via network for ${url}, attempting to trigger play...`);
            const playButtonSelectors = ['div.play-button', 'button.vjs-big-play-button', '.jw-display-icon-container', '#vplayer', 'video', 'body'];
            for (const selector of playButtonSelectors) {
                if (videoUrl) break;
                try {
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

        if (!videoUrl) {
            const detectedProvider = Object.keys(PROVIDERS).find(p => url.includes(p));
            if (detectedProvider) {
                videoUrl = await PROVIDERS[detectedProvider](page).catch(() => null);
            } else {
                videoUrl = await page.evaluate(() => document.querySelector('video')?.src).catch(() => null);
            }
        }

        if (videoUrl && isValidStreamUrl(videoUrl)) {
            streamCache.set(cacheKey, videoUrl);
            return videoUrl;
        }
        return null;
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

function defineHandlers(builder, getBrowser) {
    builder.defineCatalogHandler(async ({type, id, extra}) => {
        console.log("[Addon] request for catalog: " + type + " " + id);
        let url;
        if (extra?.search) {
            url = `${LATANIME_URL}/buscar?q=${encodeURIComponent(extra.search)}`;
        } else if (id === 'latanime-new') {
            url = LATANIME_URL;
        } else {
            const page = extra?.skip ? Math.floor(extra.skip / ITEMS_PER_PAGE) + 1 : 1;
            url = `${LATANIME_URL}/animes?page=${page}`;
        }

        try {
            const html = await fetchWithScrapingBee(url, true);
            const $ = cheerio.load(html);
            const metas = [];
            const itemsSelector = (id === 'latanime-new' && !extra?.search) ? 'h2:contains("Series recientes") + ul li article a' : 'div[class^="col-"] a';

            $(itemsSelector).each((i, el) => {
                const href = $(el).attr('href');
                if (href?.includes('/anime/')) {
                    const poster = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
                    metas.push({
                        id: `latanime-${normalizeId(href)}`,
                        type: 'series',
                        name: $(el).find('h3').text().trim(),
                        poster: poster,
                    });
                }
            });

            console.log(`Found ${metas.length} items in catalog`);
            return { metas };
        } catch (error) {
            console.error("Error fetching catalog:", error.message);
            return { metas: [] };
        }
    });

    builder.defineMetaHandler(async ({type, id}) => {
        console.log("request for meta: " + type + " " + id);
        const animeId = normalizeId(id);
        const url = `${LATANIME_URL}/anime/${animeId}`;

        try {
            const html = await fetchWithScrapingBee(url);
            const $ = cheerio.load(html);

            const meta = {
                id: id,
                type: 'series',
                name: $('h2, h1.title, .serie-title').first().text().trim(),
                poster: $('.serieimgficha img, .poster img, meta[property="og:image"]').first().attr('src') || $('.serieimgficha img, .poster img, meta[property="og:image"]').first().attr('content'),
                description: $('p.my-2.opacity-75, .description, meta[property="og:description"]').first().text().trim(),
                videos: []
            };

            const episodeMap = new Map();
            $('.cap-layout a, .episode-item a, .video-list-item a, a[href*="/ver/"]').each((i, el) => {
                const href = $(el).attr('href');
                if (href?.includes('/ver/')) {
                    const episodeId = normalizeId(href);
                    if (!episodeMap.has(episodeId)) {
                        const epMatch = (href + $(el).text()).match(/(?:episodio|capitulo|ep|cap)[\s-]*(\d+)/i);
                        episodeMap.set(episodeId, {
                            id: `latanime-${episodeId}`,
                            title: $(el).text().trim().replace(/\s\s+/g, ' ') || `Episode`,
                            released: new Date().toISOString(),
                            season: 1,
                            episode: epMatch ? parseInt(epMatch[1], 10) : episodeMap.size + 1
                        });
                    }
                }
            });
            meta.videos = Array.from(episodeMap.values()).sort((a, b) => a.episode - b.episode);
            console.log(`Found ${meta.videos.length} episodes for ${meta.name}`);
            return { meta };
        } catch (error) {
            console.error(`Error fetching meta for ${id}:`, error.message);
            return { meta: {} };
        }
    });

    async function getLatanimeEpisodeUrl(imdbId, season, episode) {
        try {
            const cinemeta = await axios.get(`https://cinemeta-live.strem.io/meta/series/${imdbId}.json`).then(r => r.data.meta).catch(() => null);
            if (!cinemeta?.name) return null;

            const cleanName = cinemeta.name.split(':')[0].split('(')[0].trim();
            const searchHtml = await fetchWithScrapingBee(`${LATANIME_URL}/buscar?q=${encodeURIComponent(cleanName)}`, true);
            const $ = cheerio.load(searchHtml);

            let seriesUrl = null;
            const seasonRegex = new RegExp(`(temporada|season|s)[\\s-]*${season}\\b`, 'i');
            $('div.container a[href*="/anime/"]').each((i, el) => {
                const title = $(el).find('h3').text().trim();
                const href = $(el).attr('href');
                if (title.toLowerCase().includes(cleanName.toLowerCase()) && (!seasonRegex.test(title) || season === 1)) {
                    seriesUrl = href;
                    return false;
                }
                if (title.match(seasonRegex)) {
                    seriesUrl = href;
                }
            });
            seriesUrl = seriesUrl || $('div.container a[href*="/anime/"]').first().attr('href');
            if (!seriesUrl) return null;

            const seriesPageHtml = await fetchWithScrapingBee(seriesUrl);
            const $$ = cheerio.load(seriesPageHtml);
            const episodeLinks = $$('a[href*="/ver/"]').toArray().reverse();
            const epRegex = new RegExp(`(episodio|capitulo|ep|cap|\\s|e)[\\s-]*0*${episode}(?:\\b|$)`, 'i');
            const epElement = episodeLinks.find(el => $$(el).text().trim().match(epRegex) || $$(el).attr('href').match(new RegExp(`-${episode}(?:\\b|$)`)));

            return epElement ? $$(epElement).attr('href') : (episodeLinks[episode - 1] ? $$(episodeLinks[episode - 1]).attr('href') : null);
        } catch (error) {
            console.error(`Error resolving IMDb ID to Latanime URL: ${error.message}`);
            return null;
        }
    }

    builder.defineStreamHandler(async ({ type, id }) => {
        console.log("[Addon] request for streams: " + type + " " + id);
        let targetUrl;

        if (id.startsWith('tt')) {
            const [imdbId, season, episode] = id.split(':');
            targetUrl = await getLatanimeEpisodeUrl(imdbId, parseInt(season), parseInt(episode));
            if (!targetUrl) return Promise.resolve({ streams: [] });
        } else {
            targetUrl = `${LATANIME_URL}/ver/${normalizeId(id)}`;
        }

        const browser = getBrowser();
        if (!browser || !browser.isConnected()) {
            console.error('[Addon] Browser not available!');
            return Promise.resolve({ streams: [] });
        }

        try {
            const html = await fetchWithScrapingBee(targetUrl, true);
            const $ = cheerio.load(html);

            const providers = [];
            const baseKey = $('div.player').attr('data-key');
            if (baseKey) {
                const basePlayerUrl = Buffer.from(baseKey, 'base64').toString();
                $('a.play-video').each((i, el) => {
                    const providerName = $(el).text().trim();
                    const encodedPart = $(el).attr('data-player');
                    if (encodedPart) {
                        providers.push({
                            url: providerName.toLowerCase() === 'yourupload' ? Buffer.from(encodedPart, 'base64').toString() : basePlayerUrl + encodedPart,
                            title: providerName
                        });
                    }
                });
            }

            const resolvedStreams = [];
            const processProvider = async (provider) => {
                let context;
                try {
                    context = await browser.newContext();
                    await context.route('**/*', r => (['image', 'stylesheet', 'font', 'other'].includes(r.request().resourceType()) ? r.abort() : r.continue()));

                    const page = await context.newPage();
                    await page.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

                    // First, try to find a direct redirection link (atob)
                    let finalUrl = await page.evaluate(() => {
                        const match = document.body.innerHTML.match(/var redir = atob\("([^"]+)"\);/);
                        return match ? atob(match[1]) : null;
                    }).catch(() => null);

                    // If no direct link, check for an iframe
                    if (!finalUrl) {
                        finalUrl = await page.evaluate(() => document.querySelector('iframe')?.src).catch(() => null);
                    }

                    // If still no URL, the provider page itself might be the player
                    if (!finalUrl) {
                        finalUrl = provider.url;
                    }

                    console.log(`[Addon] Resolved ${provider.title} to final URL: ${finalUrl}`);

                    const videoUrl = await extractVideoUrl(context, finalUrl, provider.url);
                    if (videoUrl) {
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
                } catch (e) {
                    console.error(`[Addon] Error processing provider ${provider.title}: ${e.message}`);
                } finally {
                    if (context) await context.close().catch(() => {});
                }
            };

            const batchSize = 3;
            for (let i = 0; i < providers.length; i += batchSize) {
                const batch = providers.slice(i, i + batchSize);
                await Promise.all(batch.map(p => processProvider(p)));
            }

            const downloadLinks = [];
            $('a[href*="pixeldrain.com"], a[href*="mediafire.com"], a[href*="mega.nz"]').each((i, el) => {
                downloadLinks.push({ url: $(el).attr('href'), title: `📥 ${$(el).text().trim() || 'Download'}` });
            });

            return { streams: [...resolvedStreams, ...downloadLinks] };
        } catch (error) {
            console.error(`[Addon] Scraping error on ${targetUrl}: ${error.message}`);
            return { streams: [] };
        }
    });
}

module.exports = { defineHandlers, extractVideoUrl, isValidStreamUrl, PROVIDERS };
