const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

// --------------------
// Addon Manifest
// --------------------
const manifest = {
    id: 'org.latanime.stremio',
    version: '1.0.0',
    name: 'Latanime - Anime Latino',
    description: 'Watch anime with Spanish/Latino dubbing from latanime.org',
    logo: 'https://latanime.org/favicon.ico',
    background: 'https://i.imgur.com/tQtYYxF.jpg',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series', 'movie'],
    idPrefixes: ['latanime:'],
    catalogs: [
        {
            type: 'series',
            id: 'latanime-anime',
            name: 'Anime Series',
            extra: [
                { name: 'genre', options: getGenreOptions() },
                { name: 'skip', isRequired: false },
                { name: 'search', isRequired: false }
            ]
        },
        {
            type: 'movie',
            id: 'latanime-movies',
            name: 'Anime Movies',
            extra: [
                { name: 'genre', options: getGenreOptions() },
                { name: 'skip', isRequired: false },
                { name: 'search', isRequired: false }
            ]
        }
    ]
};

function getGenreOptions() {
    return [
        'Acción', 'Aventura', 'Carreras', 'Ciencia Ficción', 'Comedia',
        'Cyberpunk', 'Deportes', 'Drama', 'Ecchi', 'Escolares', 'Fantasía',
        'Gore', 'Harem', 'Horror', 'Josei', 'Lucha', 'Magia', 'Mecha',
        'Militar', 'Misterio', 'Música', 'Parodias', 'Psicológico',
        'Romance', 'Seinen', 'Shojo', 'Shonen', 'Sobrenatural', 'Vampiros',
        'Yaoi', 'Yuri', 'Histórico', 'Samurai', 'Artes Marciales', 'Demonios'
    ];
}

// --------------------
// Initialize Addon Builder
// --------------------
const builder = new addonBuilder(manifest);

// --------------------
// Latanime API Utility
// --------------------
class LatanimeAPI {
    constructor() {
        this.baseURL = 'https://latanime.org';
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
        this.client = axios.create({
            timeout: 15000,
            headers: {
                'User-Agent': this.userAgent,
                'Referer': this.baseURL,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate'
            }
        });
    }

    // --------------------
    // Catalog
    // --------------------
    async getCatalog(type, genre, skip = 0, search = '') {
        try {
            let url = `${this.baseURL}/animes`;
            const params = new URLSearchParams();
            if (search) params.append('search', search);
            if (genre && genre !== 'all') params.append('genre', genre);
            if (skip > 0) params.append('page', Math.floor(skip / 24) + 1);
            if (params.toString()) url += '?' + params.toString();

            const response = await this.client.get(url);
            const $ = cheerio.load(response.data);
            const items = [];

            $('.anime-item, .content-item, .series-item').each((i, element) => {
                const $item = $(element);
                const title = $item.find('.title, h3, .name').text().trim();
                const link = $item.find('a').attr('href');
                const poster = $item.find('img').attr('src') || $item.find('img').attr('data-src');
                const year = $item.find('.year, .date').text().match(/\d{4}/)?.[0];
                const genres = $item.find('.genre, .tags').text().trim();

                if (title && link) {
                    const id = this.extractIdFromUrl(link);
                    const itemType = this.determineType(title, genres);
                    if ((type === 'series' && itemType !== 'series') || (type === 'movie' && itemType !== 'movie')) return;

                    items.push({
                        id: `latanime:${id}`,
                        type: itemType,
                        name: title,
                        poster: this.resolveURL(poster),
                        year: year ? parseInt(year) : undefined,
                        genres: genres ? [genres] : undefined
                    });
                }
            });

            return items;
        } catch (err) {
            console.error('Error fetching catalog:', err.message);
            return [];
        }
    }

    // --------------------
    // Meta
    // --------------------
    async getMeta(id) {
        try {
            const animeId = id.replace('latanime:', '');
            const url = `${this.baseURL}/anime/${animeId}`;
            const response = await this.client.get(url);
            const $ = cheerio.load(response.data);

            const title = $('.anime-title, .title, h1').first().text().trim();
            const poster = $('.anime-poster img, .poster img').attr('src') || $('.anime-poster img, .poster img').attr('data-src');
            const background = $('.anime-bg, .background').attr('style')?.match(/url\(([^)]+)\)/)?.[1];
            const description = $('.synopsis, .description, .summary').text().trim();
            const year = $('.year, .date').text().match(/\d{4}/)?.[0];
            const genres = $('.genre-list .genre, .genres span').map((i, el) => $(el).text()).get();
            const rating = parseFloat($('.rating, .score').text().match(/[\d.]+/)?.[0]) || undefined;

            const videos = [];
            $('.episode-list .episode, .episodes .episode').each((i, element) => {
                const $ep = $(element);
                const epNumber = $ep.find('.episode-number, .ep-num').text().match(/\d+/)?.[0];
                const epTitle = $ep.find('.episode-title, .ep-title').text().trim();
                const epId = $ep.find('a').attr('href');
                if (epNumber && epId) {
                    videos.push({
                        id: `latanime:${animeId}:${epNumber}`,
                        title: epTitle || `Episode ${epNumber}`,
                        season: 1,
                        episode: parseInt(epNumber),
                        overview: epTitle
                    });
                }
            });

            const type = this.determineType(title, genres.join(' '));
            return {
                id: `latanime:${animeId}`,
                type,
                name: title,
                poster: this.resolveURL(poster),
                background: this.resolveURL(background),
                description,
                year: year ? parseInt(year) : undefined,
                genres,
                imdbRating: rating,
                videos: type === 'series' ? videos : undefined
            };
        } catch (err) {
            console.error('Error fetching meta:', err.message);
            return null;
        }
    }

    // --------------------
    // Streams
    // --------------------
    async getStreams(id) {
        try {
            const [_, animeId, episodeNum = '1'] = id.split(':');
            const urls = [
                `${this.baseURL}/ver/${animeId}-episodio-${episodeNum}`,
                `${this.baseURL}/ver/${animeId}-${episodeNum}`,
                `${this.baseURL}/ver/${animeId}/episodio-${episodeNum}`,
                `${this.baseURL}/anime/${animeId}/episodio/${episodeNum}`
            ];

            let response;
            for (const url of urls) {
                try {
                    response = await this.client.get(url);
                    break;
                } catch {}
            }

            if (!response) throw new Error('Episode page not found');

            const $ = cheerio.load(response.data);
            const streams = [];
            await this.extractMegaLinks($, streams);
            await this.extractGoogleDriveLinks($, streams);
            await this.extractMediaFireLinks($, streams);
            await this.extractGenericVideoLinks($, streams);
            return streams;
        } catch (err) {
            console.error('Error fetching streams:', err.message);
            return [];
        }
    }

    // --------------------
    // Extraction Helpers
    // --------------------
    async extractMegaLinks($, streams) {
        $('a[href*="mega.nz"], iframe[src*="mega.nz"]').each((i, el) => {
            const $e = $(el);
            const url = $e.attr('href') || $e.attr('src');
            if (url) streams.push({ url, title: 'MEGA', quality: '720p', behaviorHints: { bingeGroup: 'latanime-mega' } });
        });
    }

    async extractGoogleDriveLinks($, streams) {
        $('iframe[src*="drive.google.com"]').each((i, el) => {
            const $e = $(el);
            let url = $e.attr('src');
            if (!url) return;
            if (url.includes('/preview')) url = url.replace('/preview', '/view');
            streams.push({ url, title: 'Google Drive', quality: '720p', behaviorHints: { bingeGroup: 'latanime-gdrive' } });
        });
    }

    async extractMediaFireLinks($, streams) {
        $('a[href*="mediafire.com"]').each((i, el) => {
            const $e = $(el);
            const url = $e.attr('href');
            if (url) streams.push({ url, title: 'MediaFire', quality: '720p', behaviorHints: { bingeGroup: 'latanime-mediafire' } });
        });
    }

    async extractGenericVideoLinks($, streams) {
        const selectors = [
            'iframe[src*="streamtape.com"]',
            'iframe[src*="doodstream.com"]',
            'iframe[src*="upstream.to"]',
            'iframe[src*="fembed"]'
        ];
        selectors.forEach(sel => {
            $(sel).each((i, el) => {
                const url = $(el).attr('src');
                if (url) streams.push({ url, title: 'Embed', quality: '720p', behaviorHints: { bingeGroup: 'latanime-embed' } });
            });
        });

        $('video source, video').each((i, el) => {
            const url = $(el).attr('src');
            if (url) streams.push({ url: this.resolveURL(url), title: 'Direct', quality: '720p', behaviorHints: { bingeGroup: 'latanime-direct' } });
        });
    }

    extractIdFromUrl(url) {
        if (!url) return null;
        const match = url.match(/\/(?:ver|anime)\/([^\/\?]+)/);
        return match ? match[1] : url.split('/').pop();
    }

    determineType(title, genres) {
        const movieKeywords = ['película', 'movie', 'film', 'pelicula'];
        const lowerTitle = title.toLowerCase();
        const lowerGenres = (genres || '').toLowerCase();
        return movieKeywords.some(k => lowerTitle.includes(k) || lowerGenres.includes(k)) ? 'movie' : 'series';
    }

    resolveURL(url) {
        if (!url) return null;
        if (url.startsWith('http')) return url;
        if (url.startsWith('//')) return 'https:' + url;
        if (url.startsWith('/')) return this.baseURL + url;
        return url;
    }
}

// --------------------
// Initialize API
// --------------------
const api = new LatanimeAPI();

// --------------------
// Define Addon Handlers
// --------------------
builder.defineCatalogHandler(async ({ type, extra }) => {
    const metas = await api.getCatalog(type, extra?.genre, parseInt(extra?.skip) || 0, extra?.search);
    return { metas };
});

builder.defineMetaHandler(async ({ id }) => {
    const meta = await api.getMeta(id);
    return { meta };
});

builder.defineStreamHandler(async ({ id }) => {
    const streams = await api.getStreams(id);
    return { streams };
});

// --------------------
// Export Addon
// --------------------
module.exports = builder.getInterface();

// --------------------
// Standalone Express Server
// --------------------
if (require.main === module) {
    const express = require('express');
    const cors = require('cors');

    const app = express();
    app.use(cors());

    const addonInterface = builder.getInterface();
    app.use('/', getRouter(addonInterface)); // ✅ Fixed middleware

    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`Latanime Stremio addon running on port ${port}`);
        console.log(`Manifest: http://localhost:${port}/manifest.json`);
    });
}
