const { addonBuilder } = require("stremio-addon-sdk");
const cheerio = require("cheerio");
const { ScrapingBeeClient } = require("scrapingbee");
const NodeCache = require("node-cache");

const manifest = {
    "id": "org.latanime.stremio",
    "version": "1.0.3",
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
        },
        {
            "type": "series",
            "id": "latanime-new",
            "name": "Nuevas Series"
        }
    ],
    "idPrefixes": ["latanime-"]
};

const builder = new addonBuilder(manifest);

const LATANIME_URL = "https://latanime.org";
const ITEMS_PER_PAGE = 28;

// Use environment variable for API key, fallback to provided key if not set (for testing)
// In production, always set SCRAPINGBEE_API_KEY
const SB_API_KEY = process.env.SCRAPINGBEE_API_KEY || '8MI4VBHDP2PUDO8WU39BC7P2LDSSJ69KX5L5ORQQS0YGKBM73JP46FSNT2DE0XJ6K9T3HHN1CF8E6CU9';

const sbClient = new ScrapingBeeClient(SB_API_KEY);
const cache = new NodeCache({ stdTTL: 86400 }); // 24 hours default TTL

async function fetchWithScrapingBee(url) {
    const cached = cache.get(url);
    if (cached) {
        console.log(`Cache hit for ${url}`);
        return cached;
    }

    console.log(`Fetching ${url} via ScrapingBee`);
    try {
        const response = await sbClient.get({
            url: url,
            params: {
                render_js: 'false',
            },
        });

        if (response.status !== 200) {
            throw new Error(`ScrapingBee returned status ${response.status}`);
        }

        let data = response.data;

        // Handle potential buffer/string difference
        if (typeof data !== 'string') {
             const decoder = new TextDecoder();
             data = decoder.decode(data);
        }

        cache.set(url, data);
        return data;
    } catch (error) {
        console.error(`Error fetching ${url}:`, error.message);
        throw error;
    }
}

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
        const html = await fetchWithScrapingBee(url);
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

        } else {
            $('div[class^="col-"] a').each((i, el) => {
                const href = $(el).attr('href');
                if (href && href.includes('/anime/')) {
                    const title = $(el).find('h3').text().trim();
                    const img = $(el).find('img');
                    const poster = img.attr('data-src') || img.attr('src');
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
        }

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
        const html = await fetchWithScrapingBee(url);
        const $ = cheerio.load(html);
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
        const html = await fetchWithScrapingBee(url);
        const $ = cheerio.load(html);

        const streams = [];

        $('a[data-player], button[data-player]').each((i, el) => {
            const encodedPlayerUrl = $(el).attr('data-player');
            const providerName = $(el).text().trim();
            if (encodedPlayerUrl) {
                try {
                    const decodedUrl = Buffer.from(encodedPlayerUrl, 'base64').toString('utf8');
                    if (decodedUrl) {
                        streams.push({
                            url: decodedUrl,
                            title: providerName,
                            behaviorHints: {
                                notWebReady: true
                            }
                        });
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
                streams.push({
                    url: href,
                    title: `[Download] ${name}`
                });
            }
        });

        return Promise.resolve({ streams: streams });
    } catch (error) {
        console.error(`Error fetching streams for ${id}:`, error.message);
        return Promise.resolve({ streams: [] });
    }
});

module.exports = builder.getInterface();
