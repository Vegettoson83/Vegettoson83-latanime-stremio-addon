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
const ITEMS_PER_PAGE = 28; // Estimate based on typical grid

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
};

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
        const response = await axios.get(url, { headers });
        const $ = cheerio.load(response.data);
        const metas = [];

        if (id === 'latanime-new' && !extra?.search) {
             // Homepage "Series recientes" parsing
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
            // Standard catalog and search parsing
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
        const response = await axios.get(url, { headers });
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
        const response = await axios.get(url, { headers });
        const $ = cheerio.load(response.data);

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
