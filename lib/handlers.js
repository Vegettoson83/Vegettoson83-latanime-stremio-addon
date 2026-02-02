const cheerio = require("cheerio");
const axios = require("axios");
const {
    LATANIME_URL,
    ITEMS_PER_PAGE,
    fetchWithScrapingBee,
    normalizeId
} = require("./scraping");
const { extractVideoUrl } = require("./browserScraper");

function defineHandlers(builder, getBrowser) {
    builder.defineCatalogHandler(async ({type, id, extra}) => {
        console.log("[Addon] request for catalog: " + type + " " + id);

        let url;
        if (extra && extra.search) {
            url = `${LATANIME_URL}/buscar?q=${encodeURIComponent(extra.search)}`;
        } else if (id === 'latanime-new') {
            url = LATANIME_URL;
        } else {
            let page = 1;
            if (extra && extra.skip) {
                page = Math.floor(extra.skip / ITEMS_PER_PAGE) + 1;
            }
            url = `${LATANIME_URL}/animes?page=${page}`;
        }

        try {
            const html = await fetchWithScrapingBee(url, true);
            const $ = cheerio.load(html);
            const metas = [];

            if (id === 'latanime-new' && !extra?.search) {
                 const section = $('h2:contains("Series recientes")').next('ul');
                 section.find('li article a').each((i, el) => {
                     const href = $(el).attr('href');
                     if (href && href.includes('/anime/')) {
                         const title = $(el).find('h3').text().trim();
                         const img = $(el).find('img');
                         const poster = img.attr('data-src') || img.attr('src');
                         const animeId = normalizeId(href);

                         if (animeId) {
                             metas.push({
                                 id: `latanime-${animeId}`,
                                 type: 'series',
                                 name: title,
                                 poster: poster,
                             });
                         }
                     }
                 });

            } else {
                $('div[class^="col-"] a').each((i, el) => {
                    const href = $(el).attr('href');
                    if (href && href.includes('/anime/')) {
                        const title = $(el).find('h3').text().trim();
                        const img = $(el).find('img');
                        const poster = img.attr('data-src') || img.attr('src');
                        const animeId = normalizeId(href);
                        if (animeId) {
                            metas.push({
                                id: `latanime-${animeId}`,
                                type: 'series',
                                name: title,
                                poster: poster,
                            });
                        }
                    }
                });
            }

            console.log(`Found ${metas.length} items in catalog`);
            return Promise.resolve({ metas: metas });
        } catch (error) {
            console.error("Error fetching catalog:", error.message);
            return Promise.resolve({ metas: [] });
        }
    });

    builder.defineMetaHandler(async ({type, id}) => {
        console.log("request for meta: " + type + " " + id);
        const animeId = normalizeId(id);
        const url = `${LATANIME_URL}/anime/${animeId}`;

        try {
            const html = await fetchWithScrapingBee(url);
            const $ = cheerio.load(html);

            const findFirst = (selectors) => {
                for (const selector of selectors) {
                    const element = $(selector);
                    if (element.length > 0) {
                        if (selector.endsWith('img') || selector.startsWith('meta')) {
                            return element.attr('src') || element.attr('content');
                        }
                        return element.text().trim();
                    }
                }
                return '';
            };

            const title = findFirst(['h2', 'h1.title', '.serie-title']);
            const poster = findFirst(['.serieimgficha img', '.poster img', 'meta[property="og:image"]']);
            const description = findFirst(['p.my-2.opacity-75', '.description', 'meta[property="og:description"]']);

            const videos = [];
            const episodeMap = new Map();

            const episodeContainers = [
                '.cap-layout a',
                '.episode-item a',
                '.video-list-item a',
                'a[href*="/ver/"]'
            ];

            episodeContainers.forEach(selector => {
                $(selector).each((i, el) => {
                    const href = $(el).attr('href');
                    if (href && href.includes('/ver/')) {
                        const episodeTitleRaw = $(el).text().trim().replace(/\s\s+/g, ' ');
                        const episodeId = normalizeId(href);

                        if (episodeId && !episodeMap.has(episodeId)) {
                            let season = 1;
                            let episode = i + 1;

                            const epMatch = episodeTitleRaw.match(/(?:episodio|capitulo|ep|cap)\s*(\d+)/i)
                                         || episodeId.match(/(?:episodio|capitulo|ep|cap)-(\d+)/i)
                                         || episodeTitleRaw.match(/(\d+)$/);

                            if (epMatch) {
                                episode = parseInt(epMatch[1], 10);
                            }

                            const seasonMatch = animeId.match(/(?:temporada|season)-(\d+)/i)
                                             || title.match(/temporada\s*(\d+)/i);
                            if (seasonMatch) {
                                season = parseInt(seasonMatch[1], 10);
                            }

                            episodeMap.set(episodeId, {
                                id: `latanime-${episodeId}`,
                                title: episodeTitleRaw || `Episode ${episode}`,
                                released: new Date().toISOString(),
                                season: season,
                                episode: episode
                            });
                        }
                    }
                });
            });

            const sortedVideos = Array.from(episodeMap.values()).sort((a, b) => {
                if (a.season !== b.season) return a.season - b.season;
                return a.episode - b.episode;
            });

            console.log(`Found ${sortedVideos.length} episodes for ${title}`);

            const meta = {
                id: id,
                type: 'series',
                name: title || 'Unknown',
                poster: poster,
                description: description,
                videos: sortedVideos
            };

            return Promise.resolve({ meta: meta });
        } catch (error) {
            console.error(`Error fetching meta for ${id}:`, error.message);
            return Promise.resolve({ meta: {} });
        }
    });

    async function getLatanimeEpisodeUrl(imdbId, season, episode) {
        try {
            const cinemetaUrl = `https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`;
            const cinemetaResponse = await axios.get(cinemetaUrl);
            const seriesName = cinemetaResponse.data.meta.name;
            console.log(`Resolved ${imdbId} to series name: "${seriesName}"`);

            const searchUrl = `${LATANIME_URL}/buscar?q=${encodeURIComponent(seriesName)}`;
            const searchHtml = await fetchWithScrapingBee(searchUrl, true);
            let $ = cheerio.load(searchHtml);

            let seriesUrl = null;
            const searchResults = $('div.container a[href*="/anime/"]');

            if (searchResults.length > 0) {
                if (searchResults.length === 1) {
                    seriesUrl = searchResults.first().attr('href');
                } else {
                    const seasonRegex = new RegExp(`(temporada|season|s)[\\s\\-]*${season}\\b`, 'i');
                    const exactMatchRegex = new RegExp(`^${seriesName}(?:\\s(latino|castellano))?$`, 'i');

                    let perfectMatches = [];
                    let seasonMatch = null;

                    searchResults.each((i, el) => {
                        const link = $(el);
                        const title = link.find('h3').text().trim();
                        const href = link.attr('href');

                        if (title.match(exactMatchRegex)) {
                            perfectMatches.push(href);
                        }
                        if (season > 1 && (title.match(seasonRegex) || href.match(seasonRegex))) {
                           if (!seasonMatch) seasonMatch = href;
                        }
                    });

                    let perfectMatch = perfectMatches.find(href => href.includes('latino')) || perfectMatches[0];
                    seriesUrl = perfectMatch || seasonMatch || searchResults.first().attr('href');
                }
            }

            if (!seriesUrl) {
                console.log(`No series URL found for "${seriesName}" Season ${season}`);
                return null;
            }
            console.log(`Found series URL for S${season}: ${seriesUrl}`);

            let currentPageUrl = seriesUrl;
            let episodeUrl = null;
            const MAX_PAGES_TO_CHECK = 10;
            let pagesChecked = 0;

            const episodeNumberPattern = `0*${episode}(?:\\b|$)`;
            const textRegex = new RegExp(`(episodio|capitulo|ep|cap|\\s|e)[\\s-]*${episodeNumberPattern}`, 'i');
            const hrefRegex = new RegExp(`-${episodeNumberPattern}`, 'i');
            const exactTextRegex = new RegExp(`^${episode}$`);

            while (currentPageUrl && pagesChecked < MAX_PAGES_TO_CHECK) {
                const seriesPageHtml = await fetchWithScrapingBee(currentPageUrl, true);
                $ = cheerio.load(seriesPageHtml);
                pagesChecked++;

                const episodeLinks = $('a[href*="/ver/"]').toArray().reverse();

                for (const el of episodeLinks) {
                    const link = $(el);
                    const linkText = link.text().trim();
                    const linkHref = link.attr('href') || '';

                    if (linkText.match(textRegex) || linkText.match(exactTextRegex) || linkHref.match(hrefRegex)) {
                        episodeUrl = linkHref;
                        break;
                    }
                }

                if (episodeUrl) break;

                const nextPageLink = $('a[rel="next"]').attr('href');
                if (nextPageLink && nextPageLink !== '#') {
                    currentPageUrl = nextPageLink;
                } else {
                    currentPageUrl = null;
                }
            }

            if (episodeUrl) {
                console.log(`Found episode URL: ${episodeUrl}`);
                return episodeUrl;
            } else {
                console.log(`Could not find episode ${episode} for season ${season}`);
                return null;
            }

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
            if (!targetUrl) {
                console.error(`[Addon] Could not resolve IMDb ID ${id} to a Latanime URL.`);
                return Promise.resolve({ streams: [] });
            }
        } else {
            const episodeId = normalizeId(id);
            targetUrl = `${LATANIME_URL}/ver/${episodeId}`;
        }

        try {
            const html = await fetchWithScrapingBee(targetUrl, false);
            const $ = cheerio.load(html);

            const providerUrls = [];
            const baseKey = $('div.player')?.attr('data-key');
            const reproductorPrefix = baseKey ? atob(baseKey) : 'https://latanime.org/reproductor?url=';

            $('a.play-video').each((i, el) => {
                const providerName = $(el).text().trim();
                const encodedPart = $(el).attr('data-player');
                if (encodedPart) {
                    const proxyUrl = reproductorPrefix + encodedPart;
                    providerUrls.push({ name: providerName, url: proxyUrl });
                }
            });

            const downloadLinks = [];
            $('a[href*="pixeldrain.com"], a[href*="mediafire.com"], a[href*="mega.nz"], a[href*="gofile.io"], a[href*="drive.google.com"], a[href*="1fichier.com"], a[download]').each((i, el) => {
                if (el.attribs.href) {
                    downloadLinks.push({
                        url: el.attribs.href,
                        title: `📥 ${$(el).text().trim() || 'Download'}`
                    });
                }
            });

            console.log(`[Addon] Found ${providerUrls.length} stream providers and ${downloadLinks.length} download links. Processing providers...`);

            let resolvedStreams = [];
            try {
                for (const provider of providerUrls) {
                    const videoUrl = await extractVideoUrl(getBrowser, provider.url, targetUrl);
                    if (videoUrl) {
                        console.log(`[Addon] ✅ Extracted: ${provider.name} -> ${videoUrl.substring(0, 60)}...`);
                        resolvedStreams.push({
                            name: 'Latanime',
                            url: videoUrl,
                            title: provider.name,
                            behaviorHints: {
                                proxyHeaders: {
                                    'request': {
                                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                        'Referer': new URL(provider.url).origin
                                    }
                                }
                            }
                        });
                    }
                }
            } catch (scraperError) {
                console.error(`[Addon] A non-critical error occurred during provider scraping for ${targetUrl}:`, scraperError.message);
                // This error is considered non-critical. The function will proceed to return any discovered download links.
            }

            const allStreams = [...resolvedStreams, ...downloadLinks];

            console.log(`[Addon] Successfully resolved ${resolvedStreams.length} streams. Total sources returned: ${allStreams.length}`);
            return { streams: allStreams };

        } catch (error) {
            console.error(`[Addon] A critical error occurred in stream handler for ${targetUrl}:`, error.message);
            return Promise.resolve({ streams: [] });
        }
    });
}

module.exports = { defineHandlers };
