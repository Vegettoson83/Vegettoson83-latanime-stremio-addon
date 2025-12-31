const cheerio = require("cheerio");
const axios = require("axios");
const {
    LATANIME_URL,
    ITEMS_PER_PAGE,
    fetchWithScrapingBee,
    normalizeId
} = require("./scraping");

function defineHandlers(builder) {
    builder.defineCatalogHandler(async ({type, id, extra}) => {
        console.log("request for catalog: " + type + " " + id);

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

    const BRIDGE_URL = 'http://localhost:3001'; // The bridge service

    const slugify = (str) => {
        return str.toString().toLowerCase().trim()
            .replace(/[^\w\s-]/g, '') // remove non-word [a-z0-9_], non-whitespace, non-hyphen chars
            .replace(/[\s_-]+/g, '-') // swap any length of whitespace, underscore, hyphen characters with a single -
            .replace(/^-+|-+$/g, ''); // remove leading, trailing -
    };

    builder.defineStreamHandler(async ({ type, id }) => {
        console.log("request for streams: " + type + " " + id);
        if (!id.includes(':')) {
            console.error('Stream handler received an invalid ID format:', id);
            return Promise.resolve({ streams: [] });
        }

        try {
            const [imdbId, season, episode] = id.split(':');

            // 1. Get the series name from Cinemeta
            const cinemetaUrl = `https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`;
            const cinemetaResponse = await axios.get(cinemetaUrl);
            const seriesName = cinemetaResponse.data.meta.name;
            console.log(`Found series name: ${seriesName}`);

            // 2. Use the site's search to find the canonical series page
            const searchUrl = `${LATANIME_URL}/buscar?q=${encodeURIComponent(seriesName)}`;
            console.log(`Searching for series at: ${searchUrl}`);
            const searchHtml = await fetchWithScrapingBee(searchUrl, true); // JS required
            const $search = cheerio.load(searchHtml);

            let seriesPageUrl = null;
            const searchResults = [];
            $search('div[class^="col-"] a').each((i, el) => {
                const link = $search(el);
                const title = link.find('h3').text().trim();
                const href = link.attr('href');
                if (href && title.toLowerCase().includes(seriesName.toLowerCase())) {
                    searchResults.push({ title, href });
                }
            });

            if (searchResults.length > 0) {
                // New, more robust season matching pattern
                const seasonPattern = new RegExp(`(temporada|season|s)[ -]*0?${season}`, 'i');

                for (const result of searchResults) {
                    if (seasonPattern.test(result.title) || seasonPattern.test(result.href)) {
                        seriesPageUrl = result.href;
                        break;
                    }
                }

                // Fallback for S1/S2 combined pages
                if (!seriesPageUrl && season == 1) {
                     for (const result of searchResults) {
                        if (result.title.includes("S1") || result.href.includes("s1")) {
                            seriesPageUrl = result.href;
                            break;
                        }
                    }
                }

                if (!seriesPageUrl) {
                    seriesPageUrl = searchResults[0].href;
                }
            }

            if (!seriesPageUrl) {
                console.error(`Could not find a matching series page for "${seriesName}" in search results.`);
                return Promise.resolve({ streams: [] });
            }

            seriesPageUrl = new URL(seriesPageUrl, LATANIME_URL).toString();
            console.log(`Discovered series page URL: ${seriesPageUrl}`);

            // 3. Scrape the series page to find the correct episode URL
            const seriesHtml = await fetchWithScrapingBee(seriesPageUrl, true); // JS required
            const $series = cheerio.load(seriesHtml);

            let episodeUrl = null;
            const episodeSelectors = ['.cap-layout a', '.episode-item a', '.video-list-item a', 'a[href*="/ver/"]'];
            for (const selector of episodeSelectors) {
                $series(selector).each((i, el) => {
                    const href = $series(el).attr('href');
                    const linkText = $series(el).text().trim().toLowerCase();
                    const epMatch = linkText.match(/(?:ep|capitulo|episodio)\s*(\d+)/) || (href && href.match(/(?:ep|capitulo|episodio)-(\d+)/));

                    if (epMatch && parseInt(epMatch[1], 10) == episode) {
                        const seasonMatch = linkText.match(/(?:temporada|season)\s*(\d+)/) || (href && href.match(/(?:temporada|season)-(\d+)/));
                        if (seasonMatch && parseInt(seasonMatch[1], 10) == season) {
                            episodeUrl = href;
                            return false;
                        }
                        if (!seasonMatch && !episodeUrl) {
                            episodeUrl = href;
                        }
                    }
                });
                if (episodeUrl) break;
            }

            if (!episodeUrl) {
                 console.error(`Could not find episode ${episode} for season ${season} on the series page.`);
                 return Promise.resolve({ streams: [] });
            }

            const urlToScrape = new URL(episodeUrl, LATANIME_URL).toString();
            console.log(`Discovered final episode URL to scrape: ${urlToScrape}`);

            // 4. Scrape the episode page for provider links
            const initialHtml = await fetchWithScrapingBee(urlToScrape, true);
            const $ = cheerio.load(initialHtml);
            const mainContainer = $('div.seiya');
            if (mainContainer.length === 0) {
                console.error("Could not find the main video container ('div.seiya'). Structure may have changed.");
                return Promise.resolve({ streams: [] });
            }

            const intermediateProviders = [];
            const baseKey = mainContainer.find('div.player').attr('data-key');
            if (baseKey) {
                const basePlayerUrl = Buffer.from(baseKey, 'base64').toString('utf8');
                mainContainer.find('a.play-video').each((i, el) => {
                    const providerName = $(el).text().trim();
                    const encodedPart = $(el).attr('data-player');
                    if (encodedPart) {
                        let intermediateUrl = providerName.toLowerCase() === 'yourupload'
                            ? Buffer.from(encodedPart, 'base64').toString('utf8')
                            : basePlayerUrl + encodedPart;
                        intermediateProviders.push({ url: intermediateUrl, title: providerName });
                    }
                });
            }

            // 5. Process providers through the bridge
            const streamPromises = intermediateProviders.map(async (provider) => {
                try {
                    const playerHtml = await fetchWithScrapingBee(provider.url, true);
                    const match = playerHtml.match(/var redir = atob\("([^"]+)"\);/);
                    if (match && match[1]) {
                        const finalEmbedUrl = Buffer.from(match[1], 'base64').toString('utf8');
                        const response = await axios.get(`${BRIDGE_URL}/extract`, {
                            params: { url: finalEmbedUrl },
                            timeout: 45000
                        });
                        if (response.data.success) {
                            console.log(`✅ Extracted: ${provider.title}`);
                            return {
                                name: `Latanime`,
                                url: response.data.url,
                                title: provider.title,
                                behaviorHints: {
                                    proxyHeaders: {
                                        'request': { 'Referer': new URL(finalEmbedUrl).origin }
                                    }
                                }
                            };
                        }
                    }
                    return null;
                } catch (error) {
                    console.log(`❌ Failed to process ${provider.title}: ${error.message}`);
                    return null;
                }
            });

            const resolvedStreams = (await Promise.all(streamPromises)).filter(Boolean);
            console.log(`Total streams found: ${resolvedStreams.length}`);
            return Promise.resolve({ streams: resolvedStreams });

        } catch (error) {
            console.error(`Critical error in stream handler for ${id}:`, error.message);
            return Promise.resolve({ streams: [] });
        }
    });
}

module.exports = { defineHandlers };
