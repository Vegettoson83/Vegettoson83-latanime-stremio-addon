const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

const manifest = {
    "id": "org.latanime.stremio",
    "version": "1.0.1",
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
const ITEMS_PER_PAGE = 28; // Estimate based on typical grid

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
                
                // Parsing Season and Episode
                // Default to Season 1
                let season = 1;
                let episode = videos.length + 1; // Default fallback

                // Try to extract numbers from title
                // Example titles: "Episodio 1", "Season 2 Episode 3"
                // Note: latanime titles are often just "Episodio X" or the anime title + "Episodio X"
                const epMatch = episodeTitleRaw.match(/(?:episodio|capitulo)\s*(\d+)/i);
                if (epMatch) {
                    episode = parseInt(epMatch[1], 10);
                } else {
                    // Fallback: try to extract last number
                     const numMatch = episodeTitleRaw.match(/(\d+)$/);
                     if (numMatch) {
                         episode = parseInt(numMatch[1], 10);
                     }
                }

                // Try to find season in the Anime Title or Episode Title (rare in this site, usually S1)
                // But if the anime slug contains "temporada-2", we can infer season 2
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
            videos: videos.reverse() // Usually listed newest first, Stremio likes predictable order but we just send them all.
                                     // Actually, reversing might make them 1..N if they were N..1
                                     // Let's check index. If we rely on parsing, order doesn't matter for numbering, 
                                     // but for display it should be 1 first.
                                     // .reverse() is good if site lists newest first.
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
        // Updated selector to 'a[data-player]' based on inspection
        // Also kept 'button' just in case they mix them, using comma
        $('a[data-player], button[data-player]').each((i, el) => {
            const encodedPlayerUrl = $(el).attr('data-player');
            const providerName = $(el).text().trim();
            if (encodedPlayerUrl) {
                try {
                    const decodedUrl = Buffer.from(encodedPlayerUrl, 'base64').toString('utf8');
                    if (decodedUrl) {
                        // Check if it's a direct file or an embed
                        // If it's an embed, Stremio might not play it directly unless we resolve it.
                        // For now, we pass it as 'externalUrl' if it looks like a page, 
                        // or 'url' if it looks like a video file.
                        // Most of these are embeds (filemoon, etc).
                        // Stremio generally requires a direct stream or a supported embed.
                        // We will just return it as 'url' for now, as some players handle standard embeds.
                        
                        streams.push({
                            url: decodedUrl,
                            title: providerName,
                            behaviorHints: {
                                notWebReady: true // likely requires headers or specific player
                            }
                        });
                    }
                } catch (e) {
                    console.error(`Error decoding base64 string for ${id}:`, e.message);
                }
            }
        });
        
        // Also look for download links which are often direct video files
        // Selectors based on inspection: they seem to be just links, but maybe we can find them?
        // The inspection showed "Pixeldrain", "Mega" buttons.
        // They were <a href="...">...</a>.
        // We can scrape those too if they are simple links.
        // Based on curl:
        // <a href="https://pixeldrain.com/u/..." ...>Pixeldrain</a>
        // We can add a selector for these specific known hosts.
        
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
