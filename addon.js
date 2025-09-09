const { addonBuilder } = require("stremio-addon-sdk");
const https = require("https");
const cheerio = require("cheerio");

function get(url) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                // handle redirect
                resolve(get(response.headers.location));
            } else if (response.statusCode < 200 || response.statusCode >= 300) {
                reject(new Error('Failed to load page, status code: ' + response.statusCode));
            } else {
                const body = [];
                response.on('data', (chunk) => body.push(chunk));
                response.on('end', () => resolve(body.join('')));
            }
        }).on('error', (err) => reject(err));
    });
}

const manifest = {
    "id": "community.latanime",
    "version": "0.0.1",
    "name": "Latanime",
    "description": "Stremio addon for latanime.org",
    "resources": [
        "catalog",
        "stream",
        "meta"
    ],
    "types": ["series"],
    "catalogs": [
        {
            "type": "series",
            "id": "latanime-top",
            "name": "Latanime"
        }
    ]
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    console.log("request for catalogs: " + type + " " + id);

    if (type === 'series' && id === 'latanime-top') {
        const url = 'https://latanime.org/animes';
        const html = await get(url);
        const $ = cheerio.load(html);

        const metas = [];
        $('.animes .col-6').each((i, el) => {
            const a = $(el).find('a');
            const title = a.attr('title');
            const href = a.attr('href');
            const img = a.find('img').attr('src');

            if (title && href && img) {
                const id = href.split('/').pop();
                metas.push({
                    id: id,
                    type: 'series',
                    name: title,
                    poster: img
                });
            }
        });

        return Promise.resolve({ metas: metas });
    } else {
        return Promise.resolve({ metas: [] });
    }
});

builder.defineMetaHandler(async ({ type, id }) => {
    console.log("request for meta: " + type + " " + id);

    if (type === 'series') {
        const url = `https://latanime.org/anime/${id}`;
        const html = await get(url);
        const $ = cheerio.load(html);

        const title = $('.titulo-anime').text();
        const description = $('.sinopsis').text().trim();
        const poster = $('.anime-single-left img').attr('src');

        const genres = [];
        $('.anime-single-right .generos a').each((i, el) => {
            genres.push($(el).text());
        });

        const videos = [];
        $('.episodes-list .col-6').each((i, el) => {
            const a = $(el).find('a');
            const episodeTitle = a.attr('title');
            const href = a.attr('href');
            if (episodeTitle && href) {
                const episodeId = href.split('/').pop();
                const match = episodeTitle.match(/Capitulo (\d+)/);
                const episodeNumber = match ? parseInt(match[1]) : i + 1;

                videos.push({
                    id: episodeId,
                    title: episodeTitle,
                    season: 1, // Latanime doesn't seem to have season info, so we'll just use 1
                    episode: episodeNumber,
                    released: new Date() // No date info, so using current date
                });
            }
        });

        const meta = {
            id: id,
            type: 'series',
            name: title,
            poster: poster,
            description: description,
            genres: genres,
            videos: videos.reverse() // reverse to have episode 1 first
        };

        return Promise.resolve({ meta: meta });
    } else {
        return Promise.resolve({ meta: null });
    }
});

builder.defineStreamHandler(async ({ type, id }) => {
    console.log("request for streams: " + type + " " + id);

    if (type === 'series') {
        const url = `https://latanime.org/ver/${id}`;
        const html = await get(url);
        const $ = cheerio.load(html);

        const streams = [];
        const providers = $('.cap_repro .play-video');

        for (let i = 0; i < providers.length; i++) {
            const provider = providers.eq(i);
            const encodedUrl = provider.attr('data-player');
            if (encodedUrl) {
                try {
                    const decodedUrl = Buffer.from(encodedUrl, 'base64').toString('utf8');

                    const playerHtml = await get(decodedUrl);
                    const $$ = cheerio.load(playerHtml);

                    const videoUrl = $$('source').attr('src');
                    if (videoUrl) {
                        streams.push({
                            url: videoUrl,
                            title: provider.text().trim()
                        });
                    }
                } catch (e) {
                    console.error("Error getting stream from provider:", e);
                }
            }
        }

        return Promise.resolve({ streams: streams });
    } else {
        return Promise.resolve({ streams: [] });
    }
});

const addonInterface = builder.getInterface();

// Create a wrapper that adds CORS headers but preserves all properties of the original interface
function addonWithCors(req, res) {
    // Add CORS headers for Stremio Web
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        return res.end();
    }

    return addonInterface(req, res);
}

// Copy any properties (like .manifest) from the original interface to the wrapper
Object.keys(addonInterface).forEach((key) => {
    try { addonWithCors[key] = addonInterface[key]; } catch (e) { /* ignore */ }
});

module.exports = addonWithCors;