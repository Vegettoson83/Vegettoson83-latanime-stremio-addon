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
                const match = episodeTitle.match(/cap[íi]tulo (\d+)/i); // more robust regex
                const episodeNumber = match ? parseInt(match[1]) : i + 1;

                videos.push({
                    id: episodeId,
                    title: episodeTitle,
                    season: 1,
                    episode: episodeNumber,
                    released: new Date()
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
            videos: videos.reverse()
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

                    let videoUrl = $$('source').attr('src');

                    if (!videoUrl) {
                        const iframeSrc = $$('iframe').attr('src');
                        if (iframeSrc) {
                            const iframeHtml = await get(iframeSrc);
                            const $$$ = cheerio.load(iframeHtml);
                            videoUrl = $$$('source').attr('src');
                        }
                    }

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

module.exports = builder.getInterface();
