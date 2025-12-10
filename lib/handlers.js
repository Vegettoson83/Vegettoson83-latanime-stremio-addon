const cheerio = require("cheerio");
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

    builder.defineStreamHandler(async ({type, id}) => {
        console.log("request for streams: " + type + " " + id);
        const episodeId = normalizeId(id);
        const url = `${LATANIME_URL}/ver/${episodeId}`;

        try {
            const html = await fetchWithScrapingBee(url, true);
            const $ = cheerio.load(html);

            console.log(`Fetching streams from: ${url}`);
            console.log(`HTML length: ${html.length} chars`);

            const streams = [];
            const processedUrls = new Set();

            const mainContainer = $('div.seiya');
            if (mainContainer.length === 0) {
                console.error("Could not find the main video container ('div.seiya'). The page structure may have changed.");
                return Promise.resolve({ streams: [] });
            }

            // New logic based on user-provided JS
            const baseKey = mainContainer.find('div.player').attr('data-key');
            if (baseKey) {
                const basePlayerUrl = Buffer.from(baseKey, 'base64').toString('utf8');

                mainContainer.find('a.play-video').each((i, el) => {
                    const providerName = $(el).text().trim();
                    const encodedPart = $(el).attr('data-player');

                    if (encodedPart) {
                        let finalUrl;
                        if (providerName.toLowerCase() === 'yourupload') {
                            finalUrl = Buffer.from(encodedPart, 'base64').toString('utf8');
                        } else {
                            finalUrl = basePlayerUrl + encodedPart;
                        }

                        if (!processedUrls.has(finalUrl)) {
                             streams.push({
                                url: finalUrl,
                                title: providerName,
                                behaviorHints: {
                                    notWebReady: true
                                }
                            });
                            processedUrls.add(finalUrl);
                            console.log(`Added stream: ${providerName} -> ${finalUrl}`);
                        }
                    }
                });
            } else {
                console.warn("Could not find base player key ('div.player[data-key]'). Site structure may have changed.");
            }

            // Keep the download links part
            const downloadSelectors = [
                'a[href*="pixeldrain.com"]',
                'a[href*="mediafire.com"]',
                'a[href*="mega.nz"]',
                'a[href*="gofile.io"]',
                'a[href*="drive.google.com"]',
                'a[href*="1fichier.com"]',
                'a[download]'
            ];

            mainContainer.find(downloadSelectors.join(',')).each((i, el) => {
                const href = $(el).attr('href');
                const name = $(el).text().trim() || 'Download';
                if (href && !processedUrls.has(href)) {
                    streams.push({
                        url: href,
                        title: `📥 ${name}`
                    });
                    processedUrls.add(href);
                    console.log(`Added download: ${name} -> ${href.substring(0, 50)}...`);
                }
            });

            console.log(`Total streams found: ${streams.length}`);

            if (streams.length === 0) {
                console.log('No streams found. Dumping relevant HTML:');
                console.log(mainContainer.html().substring(0, 1500));
            }

            return Promise.resolve({ streams: streams });
        } catch (error) {
            console.error(`Error fetching streams for ${id}:`, error.message);
            return Promise.resolve({ streams: [] });
        }
    });
}

module.exports = { defineHandlers };
