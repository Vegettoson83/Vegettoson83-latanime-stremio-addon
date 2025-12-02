const { addonBuilder } = require("stremio-addon-sdk");
const cheerio = require("cheerio");
const { ScrapingBeeClient } = require("scrapingbee");
const NodeCache = require("node-cache");

const manifest = {
    "id": "org.latanime.stremio",
    "version": "1.0.4",
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

const SB_API_KEY = process.env.SCRAPINGBEE_API_KEY || '8MI4VBHDP2PUDO8WU39BC7P2LDSSJ69KX5L5ORQQS0YGKBM73JP46FSNT2DE0XJ6K9T3HHN1CF8E6CU9';

const sbClient = new ScrapingBeeClient(SB_API_KEY);
const cache = new NodeCache({ stdTTL: 86400 });

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

// Helper function to clean and normalize IDs
function normalizeId(id) {
    return id.replace(/^latanime-/, '').split('/').filter(x => x).pop().split('?')[0];
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

        // Try multiple episode selectors
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

                        // Extract episode number from title or URL
                        const epMatch = episodeTitleRaw.match(/(?:episodio|capitulo|ep|cap)\s*(\d+)/i) 
                                     || episodeId.match(/(?:episodio|capitulo|ep|cap)-(\d+)/i)
                                     || episodeTitleRaw.match(/(\d+)$/);
                        
                        if (epMatch) {
                            episode = parseInt(epMatch[1], 10);
                        }

                        // Extract season from anime ID or title
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

        // Convert map to array and sort by episode number
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
        const html = await fetchWithScrapingBee(url);
        const $ = cheerio.load(html);

        console.log(`Fetching streams from: ${url}`);
        console.log(`HTML length: ${html.length} chars`);

        const streams = [];
        const processedUrls = new Set();

        const isValidUrl = (string) => {
            try {
                new URL(string);
                return true;
            } catch (_) {
                return false;
            }
        };

        // Method 1: Check for base64 encoded player URLs
        const playerAttributes = ['data-player', 'data-src', 'data-stream', 'data-video', 'data-url'];
        
        playerAttributes.forEach(attr => {
            $(`*:not(img)[${attr}]`).each((i, el) => {
                const encodedPlayerUrl = $(el).attr(attr);
                let providerName = $(el).text().trim() || $(el).attr('title') || $(el).attr('data-title');
                
                if (!providerName || providerName.length === 0) {
                    providerName = `Server ${streams.length + 1}`;
                }

                if (encodedPlayerUrl) {
                    let decodedUrl = encodedPlayerUrl;
                    
                    // Try to decode if it looks like base64
                    if (/^[A-Za-z0-9+/=]+$/.test(encodedPlayerUrl) && encodedPlayerUrl.length > 20) {
                        try {
                            decodedUrl = Buffer.from(encodedPlayerUrl, 'base64').toString('utf8');
                        } catch (e) {
                            console.log(`Failed to decode base64: ${e.message}`);
                        }
                    }
                    
                    if (isValidUrl(decodedUrl) && !processedUrls.has(decodedUrl)) {
                        streams.push({
                            url: decodedUrl,
                            title: providerName,
                            behaviorHints: {
                                notWebReady: true
                            }
                        });
                        processedUrls.add(decodedUrl);
                        console.log(`Added stream: ${providerName} -> ${decodedUrl.substring(0, 50)}...`);
                    }
                }
            });
        });

        // Method 2: Look for iframe sources
        $('iframe').each((i, el) => {
            const src = $(el).attr('src') || $(el).attr('data-src');
            if (src && isValidUrl(src) && !processedUrls.has(src)) {
                streams.push({
                    url: src,
                    title: `iFrame Server ${i + 1}`,
                    behaviorHints: {
                        notWebReady: true
                    }
                });
                processedUrls.add(src);
                console.log(`Added iframe stream: ${src.substring(0, 50)}...`);
            }
        });

        // Method 3: Look for video tags
        $('video source, video').each((i, el) => {
            const src = $(el).attr('src');
            if (src && isValidUrl(src) && !processedUrls.has(src)) {
                streams.push({
                    url: src,
                    title: `Direct Video ${i + 1}`
                });
                processedUrls.add(src);
                console.log(`Added video stream: ${src.substring(0, 50)}...`);
            }
        });

        // Method 4: Look for download links
        const downloadSelectors = [
            'a[href*="pixeldrain.com"]',
            'a[href*="mediafire.com"]',
            'a[href*="mega.nz"]',
            'a[href*="gofile.io"]',
            'a[href*="drive.google.com"]',
            'a[download]'
        ];
        
        $(downloadSelectors.join(',')).each((i, el) => {
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

        // Method 5: Look for player buttons or links
        $('button[data-player], .player-option, .server-item').each((i, el) => {
            const dataUrl = $(el).attr('data-player') || $(el).attr('data-url') || $(el).attr('data-link');
            const name = $(el).text().trim() || `Option ${i + 1}`;
            
            if (dataUrl) {
                let finalUrl = dataUrl;
                
                // Try base64 decode
                if (/^[A-Za-z0-9+/=]+$/.test(dataUrl) && dataUrl.length > 20) {
                    try {
                        finalUrl = Buffer.from(dataUrl, 'base64').toString('utf8');
                    } catch (e) {}
                }
                
                if (isValidUrl(finalUrl) && !processedUrls.has(finalUrl)) {
                    streams.push({
                        url: finalUrl,
                        title: name,
                        behaviorHints: {
                            notWebReady: true
                        }
                    });
                    processedUrls.add(finalUrl);
                    console.log(`Added player option: ${name}`);
                }
            }
        });

        console.log(`Total streams found: ${streams.length}`);

        if (streams.length === 0) {
            console.log('No streams found. Dumping relevant HTML:');
            console.log($('body').html().substring(0, 1000));
        }

        return Promise.resolve({ streams: streams });
    } catch (error) {
        console.error(`Error fetching streams for ${id}:`, error.message);
        return Promise.resolve({ streams: [] });
    }
});

module.exports = builder.getInterface();
