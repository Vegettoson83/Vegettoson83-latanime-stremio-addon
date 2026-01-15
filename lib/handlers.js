const cheerio = require("cheerio");
const axios = require("axios");
const {
    LATANIME_URL,
    ITEMS_PER_PAGE,
    fetchWithScrapingBee,
    normalizeId
} = require("./scraping");

// All browser-related logic has been moved to the bridge server.

function defineHandlers(builder) {
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
            const cinemetaUrl = `https://cinemeta-live.strem.io/meta/series/${imdbId}.json`;
            const cinemetaResponse = await axios.get(cinemetaUrl, {
                headers: { 'User-Agent': 'Stremio - Latanime Addon' }
            });
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
                    const exactMatchRegex = new RegExp(`^${seriesName}$`, 'i');

                    let perfectMatch = null;
                    let seasonMatch = null;

                    searchResults.each((i, el) => {
                        const link = $(el);
                        const title = link.find('h3').text().trim();
                        const href = link.attr('href');

                        if (title.match(exactMatchRegex)) {
                            perfectMatch = href;
                            return false; // Stop searching once a perfect match is found
                        }
                        if (season > 1 && (title.match(seasonRegex) || href.match(seasonRegex))) {
                           if (!seasonMatch) seasonMatch = href;
                        }
                    });

                    seriesUrl = perfectMatch || seasonMatch || searchResults.first().attr('href');
                }
            }

            if (!seriesUrl) {
                console.log(`No series URL found for "${seriesName}" Season ${season}`);
                return null;
            }
            console.log(`Found series URL for S${season}: ${seriesUrl}`);

            const seriesPageHtml = await fetchWithScrapingBee(seriesUrl);
            $ = cheerio.load(seriesPageHtml);

            let episodeUrl = null;
            const episodeLinks = $('a[href*="/ver/"]').toArray().reverse();

            const episodeNumberPattern = `0*${episode}(?:\\b|$)`;
            const textRegex = new RegExp(`(episodio|capitulo|ep|cap|\\s|e)[\\s-]*${episodeNumberPattern}`, 'i');
            const hrefRegex = new RegExp(`-${episodeNumberPattern}`, 'i');
            const exactTextRegex = new RegExp(`^${episode}$`);

            for (const el of episodeLinks) {
                const link = $(el);
                const linkText = link.text().trim();
                const linkHref = link.attr('href') || '';

                if (linkText.match(textRegex) || linkText.match(exactTextRegex) || linkHref.match(hrefRegex)) {
                    episodeUrl = linkHref;
                    break;
                }
            }

            if (!episodeUrl && episodeLinks.length >= episode) {
                console.log(`No specific match found, falling back to ${episode}th link.`);
                episodeUrl = $(episodeLinks[episode - 1]).attr('href');
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

        const bridgeUrl = process.env.BRIDGE_URL || 'http://localhost:3001';
        console.log(`[Addon] Requesting streams from bridge: ${bridgeUrl} for target: ${targetUrl}`);

        try {
            // The bridge service is now responsible for the entire scraping process.
            const response = await axios.post(`${bridgeUrl}/scrape`,
                { url: targetUrl },
                { timeout: 90000 } // 90-second timeout for the entire scraping and extraction process
            );
            return Promise.resolve({ streams: response.data.streams || [] });
        } catch (error) {
            console.error(`[Addon] Error fetching streams from bridge for ${targetUrl}:`, error.message);
            if (error.response) {
                console.error('[Addon] Bridge Error Response:', error.response.data);
            }
            return Promise.resolve({ streams: [] });
        }
    });
}

module.exports = { defineHandlers };
