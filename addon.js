const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

const manifest = {
    "id": "org.latanime.stremio",
    "version": "1.0.0",
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
                { "name": "skip", "isRequired": false }
            ]
        }
    ],
    "idPrefixes": ["latanime-"]
};

const builder = new addonBuilder(manifest);

const LATANIME_URL = "https://latanime.org";

const PAGE_SIZE = 36; // Number of items per page on latanime.org
const PREFERRED_HOSTS = ['filemoon', 'mp4upload', 'mixdrop', 'voe', 'streamtape'];


builder.defineCatalogHandler(async ({type, id, extra}) => {
    console.log(`Request for catalog: ${type} ${id}`);
    const skip = extra.skip || 0;
    const page = Math.floor(skip / PAGE_SIZE) + 1;
    const url = `${LATANIME_URL}/animes?p=${page}`;
    console.log(`Fetching catalog from: ${url}`);

    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const metas = [];

        $('div[class^="col-"] a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('/anime/')) {
                const title = $(el).find('h3').text();
                const poster = $(el).find('img').attr('data-src');
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
        console.log(`Found ${metas.length} items in catalog.`);
        return Promise.resolve({ metas: metas });
    } catch (error) {
        console.error("Error fetching catalog:", error.message);
        return Promise.resolve({ metas: [] });
    }
})


builder.defineMetaHandler(async ({type, id}) => {
    console.log(`Request for meta: ${type} ${id}`);
    const animeId = id.replace('latanime-', '');
    const url = `${LATANIME_URL}/anime/${animeId}`;
    console.log(`Fetching meta from: ${url}`);
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const title = $('h2').text();
        const poster = $('.serieimgficha img').attr('src');
        const description = $('p.my-2.opacity-75').text();
        const genres = [];
        $('a[href*="/genero/"]').each((i, el) => {
            genres.push($(el).text());
        });

        const videos = [];
        $('.cap-layout').each((i, el) => {
            const href = $(el).parent().attr('href');
            if (href && href.includes('/ver/')) {
                const episodeTitle = $(el).text().trim().replace(/\s\s+/g, ' ');
                const episodeId = href.split('/').pop();
                const episodeNumberMatch = episodeTitle.match(/Capitulo (\d+)/i);
                const episodeNumber = episodeNumberMatch ? parseInt(episodeNumberMatch[1]) : i + 1;

                if (episodeId) {
                    videos.push({
                        id: `latanime-${episodeId}`,
                        title: episodeTitle,
                        season: 1,
                        episode: episodeNumber,
                    });
                }
            }
        });

        console.log(`Found ${videos.length} episodes for ${id}.`);
        const totalEpisodesText = $('p:contains("Episodios:")').text();
        const totalEpisodesMatch = totalEpisodesText.match(/Episodios: (\d+)/);
        if (totalEpisodesMatch && parseInt(totalEpisodesMatch[1]) !== videos.length) {
            console.warn(`Episode count mismatch for ${id}: expected ${totalEpisodesMatch[1]}, found ${videos.length}`);
        }

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
    } catch (error) {
        console.error(`Error fetching meta for ${id}:`, error.message);
        return Promise.resolve({ meta: {} });
    }
})

builder.defineStreamHandler(async ({type, id}) => {
    console.log(`Request for streams: ${type} ${id}`);
    const episodeId = id.replace('latanime-', '');
    const url = `${LATANIME_URL}/ver/${episodeId}`;
    console.log(`Fetching streams from: ${url}`);
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);

        let streams = [];
        $('button[data-player]').each((i, el) => {
            const encodedPlayerUrl = $(el).attr('data-player');
            const providerName = $(el).text().trim().toLowerCase();
            if (encodedPlayerUrl) {
                try {
                    let decodedUrl = Buffer.from(encodedPlayerUrl, 'base64').toString('utf8');
                    if (decodedUrl.startsWith('<iframe')) {
                        const $iframe = cheerio.load(decodedUrl);
                        decodedUrl = $iframe('iframe').attr('src');
                    }

                    if (decodedUrl) {
                        streams.push({
                            url: decodedUrl,
                            title: providerName
                        });
                    }
                } catch (e) {
                    console.error(`Error decoding base64 string for ${id}:`, e.message);
                }
            }
        });

        console.log(`Found ${streams.length} raw stream providers for ${id}.`);
        streams = streams.filter(s => PREFERRED_HOSTS.includes(s.title));
        console.log(`Found ${streams.length} preferred stream providers for ${id}.`);

        return Promise.resolve({ streams: streams });
    } catch (error) {
        console.error(`Error fetching streams for ${id}:`, error.message);
        return Promise.resolve({ streams: [] });
    }
})

module.exports = builder.getInterface()