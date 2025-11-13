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
            "name": "Latanime"
        }
    ],
    "idPrefixes": ["latanime-"]
};

const builder = new addonBuilder(manifest);

const LATANIME_URL = "https://latanime.org";

builder.defineCatalogHandler(async ({type, id, extra}) => {
    console.log("request for catalog: "+type+" "+id);
    const url = `${LATANIME_URL}/animes`;
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

        return Promise.resolve({ metas: metas });
    } catch (error) {
        console.error("Error fetching catalog:", error.message);
        return Promise.resolve({ metas: [] });
    }
})


builder.defineMetaHandler(async ({type, id}) => {
    console.log("request for meta: "+type+" "+id);
    const animeId = id.replace('latanime-', '');
    const url = `${LATANIME_URL}/anime/${animeId}`;
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const title = $('h2').text();
        const poster = $('.serieimgficha img').attr('src');
        const description = $('p.my-2.opacity-75').text();

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
})

builder.defineStreamHandler(async ({type, id}) => {
    console.log("request for streams: "+type+" "+id);
    const episodeId = id.replace('latanime-', '');
    const url = `${LATANIME_URL}/ver/${episodeId}`;
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);

        const streams = [];
        $('button[data-player]').each((i, el) => {
            const encodedPlayerUrl = $(el).attr('data-player');
            const providerName = $(el).text().trim();
            if (encodedPlayerUrl) {
                try {
                    const decodedUrl = Buffer.from(encodedPlayerUrl, 'base64').toString('utf8');
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
        return Promise.resolve({ streams: streams });
    } catch (error) {
        console.error(`Error fetching streams for ${id}:`, error.message);
        return Promise.resolve({ streams: [] });
    }
})

module.exports = builder.getInterface()