const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const express = require('express');
const cors = require('cors');

// --- Addon Manifest ---
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
                { name: 'genre', options: getGenres() },
                { name: 'skip', isRequired: false },
                { name: 'search', isRequired: false }
            ]
        },
        {
            type: 'movie',
            id: 'latanime-movies',
            name: 'Anime Movies',
            extra: [
                { name: 'genre', options: getGenres() },
                { name: 'skip', isRequired: false },
                { name: 'search', isRequired: false }
            ]
        }
    ]
};

function getGenres() {
    return [
        'Acción', 'Aventura', 'Carreras', 'Ciencia Ficción', 'Comedia',
        'Cyberpunk', 'Deportes', 'Drama', 'Ecchi', 'Escolares', 'Fantasía',
        'Gore', 'Harem', 'Horror', 'Josei', 'Lucha', 'Magia', 'Mecha',
        'Militar', 'Misterio', 'Música', 'Parodias', 'Psicológico',
        'Romance', 'Seinen', 'Shojo', 'Shonen', 'Sobrenatural', 'Vampiros',
        'Yaoi', 'Yuri', 'Histórico', 'Samurai', 'Artes Marciales', 'Demonios'
    ];
}

// --- Initialize Addon Builder ---
const builder = new addonBuilder(manifest);

// --- Latanime API Class ---
class LatanimeAPI {
    constructor() {
        this.baseURL = 'https://latanime.org';
        this.client = axios.create({
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': this.baseURL,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
    }

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

            $('.anime-item, .content-item, .series-item').each((i, el) => {
                const $el = $(el);
                const title = $el.find('.title, h3, .name').text().trim();
                const link = $el.find('a').attr('href');
                const poster = $el.find('img').attr('src') || $el.find('img').attr('data-src');
                const year = $el.find('.year, .date').text().match(/\d{4}/)?.[0];
                const genres = $el.find('.genre, .tags').text().trim();

                if (title && link) {
                    const id = this.extractIdFromUrl(link);
                    const itemType = this.determineType(title, genres);
                    if (type === 'series' && itemType !== 'series') return;
                    if (type === 'movie' && itemType !== 'movie') return;

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
            console.error('Catalog error:', err.message);
            return [];
        }
    }

    async getMeta(id) {
        try {
            const animeId = id.replace('latanime:', '');
            const response = await this.client.get(`${this.baseURL}/anime/${animeId}`);
            const $ = cheerio.load(response.data);

            const title = $('.anime-title, .title, h1').first().text().trim();
            const poster = $('.anime-poster img, .poster img').attr('src') || $('.anime-poster img, .poster img').attr('data-src');
            const background = $('.anime-bg, .background').attr('style')?.match(/url\(([^)]+)\)/)?.[1];
            const description = $('.synopsis, .description, .summary').text().trim();
            const year = $('.year, .date').text().match(/\d{4}/)?.[0];
            const genres = $('.genre-list .genre, .genres span').map((i, el) => $(el).text()).get();
            const rating = parseFloat($('.rating, .score').text().match(/[\d.]+/)?.[0]) || undefined;

            const videos = [];
            $('.episode-list .episode, .episodes .episode').each((i, el) => {
                const $ep = $(el);
                const epNumber = $ep.find('.episode-number, .ep-num').text().match(/\d+/)?.[0];
                const epTitle = $ep.find('.episode-title, .ep-title').text().trim();
                const epId = $ep.find('a').attr('href');
                if (epNumber && epId) videos.push({
                    id: `latanime:${animeId}:${epNumber}`,
                    title: epTitle || `Episode ${epNumber}`,
                    season: 1,
                    episode: parseInt(epNumber),
                    overview: epTitle
                });
            });

            return {
                id: `latanime:${animeId}`,
                type: this.determineType(title, genres.join(' ')),
                name: title,
                poster: this.resolveURL(poster),
                background: this.resolveURL(background),
                description,
                year: year ? parseInt(year) : undefined,
                genres,
                imdbRating: rating,
                videos: videos.length ? videos : undefined
            };
        } catch (err) {
            console.error('Meta error:', err.message);
            return null;
        }
    }

    async getStreams(id) {
        try {
            const [_, animeId, episodeNum = '1'] = id.split(':');
            const possibleUrls = [
                `${this.baseURL}/ver/${animeId}-episodio-${episodeNum}`,
                `${this.baseURL}/ver/${animeId}-${episodeNum}`,
                `${this.baseURL}/ver/${animeId}/episodio-${episodeNum}`,
                `${this.baseURL}/anime/${animeId}/episodio/${episodeNum}`
            ];

            let response;
            for (const url of possibleUrls) {
                try { response = await this.client.get(url); break; } 
                catch { continue; }
            }

            if (!response) return [];

            const $ = cheerio.load(response.data);
            const streams = [];
            await this.extractVideoLinks($, streams);
            return streams;
        } catch (err) {
            console.error('Streams error:', err.message);
            return [];
        }
    }

    async extractVideoLinks($, streams) {
        const selectors = [
            'a[href*="mega.nz"]', 'iframe[src*="mega.nz"]',
            'iframe[src*="drive.google.com"]', 'iframe[src*="googleusercontent.com"]',
            'a[href*="mediafire.com"]', 'iframe[src*="streamtape.com"]',
            'iframe[src*="doodstream.com"]', 'iframe[src*="upstream.to"]',
            'iframe[src*="fembed"]', 'iframe[src*="embed"]', 'video source', 'video'
        ];

        selectors.forEach(selector => {
            $(selector).each((i, el) => {
                const $el = $(el);
                let url = $el.attr('href') || $el.attr('src') || $el.attr('data-src');
                if (!url) return;
                if (url.startsWith('//')) url = 'https:' + url;
                if (url.startsWith('/')) url = this.baseURL + url;

                streams.push({
                    url,
                    title: this.extractHostName(url),
                    quality: this.extractQuality($el.text() || '720p'),
                    behaviorHints: { bingeGroup: 'latanime' }
                });
            });
        });
    }

    extractIdFromUrl(url) {
        const match = url.match(/\/(?:ver|anime)\/([^\/\?]+)/);
        return match ? match[1] : url.split('/').pop();
    }

    determineType(title, genres) {
        const keywords = ['película', 'movie', 'film', 'pelicula'];
        const lower = (title + ' ' + (genres || '')).toLowerCase();
        return keywords.some(k => lower.includes(k)) ? 'movie' : 'series';
    }

    extractQuality(text) {
        const m = text.match(/(\d{3,4}p|HD|4K|1080|720|480)/i);
        if (!m) return '720p';
        let q = m[1].toUpperCase();
        if (q === 'HD') q = '720p';
        if (q === '4K') q = '2160p';
        if (!q.includes('p')) q += 'p';
        return q;
    }

    extractHostName(url) {
        try { return new URL(url).hostname.replace('www.', '').split('.')[0]; }
        catch { return 'unknown'; }
    }

    resolveURL(url) {
        if (!url) return null;
        if (url.startsWith('http')) return url;
        if (url.startsWith('//')) return 'https:' + url;
        if (url.startsWith('/')) return this.baseURL + url;
        return url;
    }
}

// --- Initialize API ---
const api = new LatanimeAPI();

// --- Handlers ---
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

// --- Export addon interface ---
module.exports = builder.getInterface();

// --- Standalone server for Render ---
if (require.main === module) {
    const app = express();
    app.use(cors());
    app.use('/', builder.getInterface());
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Latanime addon running on port ${port}`));
}
