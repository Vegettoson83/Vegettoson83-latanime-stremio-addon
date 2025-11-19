const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

const manifest = {
    "id": "org.latanime.stremio",
    "version": "1.0.2",
    "name": "Latanime",
    "description": "Stremio addon for latanime.org",
    "icon": "https://latanime.org/public/img/logito.png",
    "resources": ["catalog", "stream", "meta"],
    "types": ["series"],
    "catalogs": [
        {
            "type": "series",
            "id": "latanime-series",
            "name": "Latanime",
            "extra": [
                { "name": "search", "isRequired": false },
                { "name": "skip", "isRequired": false }
            ]
        }
    ],
    "idPrefixes": ["latanime-"]
};

const builder = new addonBuilder(manifest);

const LATANIME_URL = "https://latanime.org";
const ITEMS_PER_PAGE = 28;

builder.defineCatalogHandler(async ({type, id, extra}) => {
    console.log("request for catalog: " + type + " " + id);

    let page = 1;
    if (extra && extra.skip) {
        page = Math.floor(extra.skip / ITEMS_PER_PAGE) + 1;
    }

    const url = `${LATANIME_URL}/animes?page=${page}`;

    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const metas = [];

        $('div[class^="col-"] a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('/anime/')) {
                const title = $(el).find('h3').text().trim();
                const poster = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
                const animeId = href.split('/').pop();
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

        return Promise.resolve({ metas: metas });
    } catch (error) {
        console.error("Error fetching catalog:", error.message);
        return Promise.resolve({ metas: [] });
    }
});


builder.defineMetaHandler(async ({type, id}) => {
    console.log("request for meta: " + type + " " + id);
    const animeId = id.replace('latanime-', '');
    const url = `${LATANIME_URL}/anime/${animeId}`;
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const title = $('h2').text().trim();
        const poster = $('.serieimgficha img').attr('src');
        const description = $('p.my-2.opacity-75').text().trim();

        const videos = [];
        $('.cap-layout').each((i, el) => {
            const href = $(el).parent().attr('href');
            if (href && href.includes('/ver/')) {
                const episodeTitleRaw = $(el).text().trim().replace(/\s\s+/g, ' ');
                const episodeId = href.split('/').pop();

                let season = 1;
                let episode = videos.length + 1;

                const epMatch = episodeTitleRaw.match(/(?:episodio|capitulo)\s*(\d+)/i);
                if (epMatch) {
                    episode = parseInt(epMatch[1], 10);
                } else {
                     const numMatch = episodeTitleRaw.match(/(\d+)$/);
                     if (numMatch) {
                         episode = parseInt(numMatch[1], 10);
                     }
                }

                const seasonMatch = animeId.match(/(?:temporada|season)-(\d+)/i);
                if (seasonMatch) {
                    season = parseInt(seasonMatch[1], 10);
                }

                if (episodeId) {
                    videos.push({
                        id: `latanime-${episodeId}`,
                        title: episodeTitleRaw,
                        released: new Date(),
                        season: season,
                        episode: episode
                    });
                }
            }
        });

        const meta = {
            id: id,
            type: 'series',
            name: title,
            poster: poster,
            description: description,
            videos: videos.reverse()
        };
        return Promise.resolve({ meta: meta });
    } catch (error) {
        console.error(`Error fetching meta for ${id}:`, error.message);
        return Promise.resolve({ meta: {} });
    }
});

builder.defineStreamHandler(async ({type, id}) => {
    console.log("request for streams: " + type + " " + id);
    const episodeId = id.replace('latanime-', '');
    const url = `${LATANIME_URL}/ver/${episodeId}`;
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);

        const streams = [];

        $('a[data-player], button[data-player]').each((i, el) => {
            const encodedPlayerUrl = $(el).attr('data-player');
            const providerName = $(el).text().trim();
            if (encodedPlayerUrl) {
                try {
                    let decodedUrl = Buffer.from(encodedPlayerUrl, 'base64').toString('utf8');
                    if (decodedUrl) {
                        // Clean URL
                        decodedUrl = decodedUrl.trim();

                        // Logic to determine if playable or external
                        let isDirect = false;

                        // Pixeldrain: Convert /u/ to /api/file/ for direct playback
                        if (decodedUrl.includes('pixeldrain.com/u/')) {
                            decodedUrl = decodedUrl.replace('/u/', '/api/file/');
                            isDirect = true;
                        } else if (decodedUrl.includes('pixeldrain.com/api/file/')) {
                            isDirect = true;
                        }

                        // Construct Stream Object
                        if (isDirect) {
                            streams.push({
                                url: decodedUrl,
                                title: `🚀 ${providerName} [Direct]`,
                                behaviorHints: {
                                    notWebReady: false,
                                    bingeGroup: `latanime-${providerName}`
                                }
                            });
                        } else {
                            // Fallback to external URL for embeds/unsupported players
                            streams.push({
                                externalUrl: decodedUrl,
                                title: `🌐 ${providerName} [Browser]`,
                            });
                        }
                    }
                } catch (e) {
                    console.error(`Error decoding base64 string for ${id}:`, e.message);
                }
            }
        });

        const downloadSelectors = [
            'a[href*="pixeldrain.com"]',
            'a[href*="mediafire.com"]',
            'a[href*="mega.nz"]',
            'a[href*="gofile.io"]'
        ];

        $(downloadSelectors.join(',')).each((i, el) => {
            const href = $(el).attr('href');
            const name = $(el).text().trim();
            if (href) {
                let finalUrl = href.trim();
                let isDirect = false;

                if (finalUrl.includes('pixeldrain.com/u/')) {
                    finalUrl = finalUrl.replace('/u/', '/api/file/');
                    isDirect = true;
                }

                if (isDirect) {
                    streams.push({
                        url: finalUrl,
                        title: `🚀 [Download] ${name} [Direct]`,
                         behaviorHints: {
                                    notWebReady: false,
                                    bingeGroup: `latanime-download`
                         }
                    });
                } else {
                     streams.push({
                        externalUrl: finalUrl,
                        title: `🌐 [Download] ${name} [Browser]`
                    });
                }
            }
        });

        return Promise.resolve({ streams: streams });
    } catch (error) {
        console.error(`Error fetching streams for ${id}:`, error.message);
        return Promise.resolve({ streams: [] });
    }
});

module.exports = builder.getInterface();
