// index.js
const express = require('express');
const cors = require('cors');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

// -----------------------------
// Manifest
// -----------------------------
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

// -----------------------------
// Helper Functions
// -----------------------------
function getGenreOptions() {
    return [
        'Acción','Aventura','Carreras','Ciencia Ficción','Comedia','Cyberpunk',
        'Deportes','Drama','Ecchi','Escolares','Fantasía','Gore','Harem','Horror',
        'Josei','Lucha','Magia','Mecha','Militar','Misterio','Música','Parodias',
        'Psicológico','Romance','Seinen','Shojo','Shonen','Sobrenatural','Vampiros',
        'Yaoi','Yuri','Histórico','Samurai','Artes Marciales','Demonios'
    ];
}

// -----------------------------
// Latanime API Scraper
// -----------------------------
class LatanimeAPI {
    constructor() {
        this.baseURL = 'https://latanime.org';
        this.client = axios.create({
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': this.baseURL,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            }
        });
    }

    resolveURL(url) {
        if (!url) return null;
        if (url.startsWith('http')) return url;
        if (url.startsWith('//')) return 'https:' + url;
        if (url.startsWith('/')) return this.baseURL + url;
        return url;
    }

    extractIdFromUrl(url) {
        if (!url) return null;
        const match = url.match(/\/(?:ver|anime)\/([^\/\?]+)/);
        return match ? match[1] : url.split('/').pop();
    }

    determineType(title, genres) {
        const movieKeywords = ['película','movie','film','pelicula'];
        const lowerTitle = title.toLowerCase();
        const lowerGenres = (genres || '').toLowerCase();
        if (movieKeywords.some(k => lowerTitle.includes(k) || lowerGenres.includes(k))) return 'movie';
        return 'series';
    }

    extractQuality(text) {
        if (!text) return '720p';
        const match = text.match(/(\d{3,4}p|HD|4K|1080|720|480)/i);
        if (!match) return '720p';
        let q = match[1].toUpperCase();
        if (q === 'HD') return '720p';
        if (q === '4K') return '2160p';
        if (!q.includes('p')) q += 'p';
        return q;
    }

    extractHostName(url) {
        if (!url) return 'Unknown';
        try {
            const hostname = new URL(url).hostname;
            return hostname.replace('www.','').split('.')[0];
        } catch { return 'Unknown'; }
    }

    // -----------------------------
    // Catalog
    // -----------------------------
    async getCatalog(type, genre, skip = 0, search = '') {
        try {
            let url = `${this.baseURL}/animes`;
            const params = new URLSearchParams();
            if (search) params.append('search', search);
            if (genre && genre !== 'all') params.append('genre', genre);
            if (skip > 0) params.append('page', Math.floor(skip/24)+1);
            if (params.toString()) url += '?' + params.toString();

            const res = await this.client.get(url);
            const $ = cheerio.load(res.data);
            const items = [];
            $('.anime-item, .content-item, .series-item').each((i, el) => {
                const $item = $(el);
                const title = $item.find('.title, h3, .name').text().trim();
                const link = $item.find('a').attr('href');
                const poster = $item.find('img').attr('src') || $item.find('img').attr('data-src');
                const year = $item.find('.year, .date').text().match(/\d{4}/)?.[0];
                const genres = $item.find('.genre, .tags').text().trim();

                if (!title || !link) return;

                const id = this.extractIdFromUrl(link);
                const itemType = this.determineType(title, genres);

                if ((type==='series' && itemType!=='series') || (type==='movie' && itemType!=='movie')) return;

                items.push({
                    id: `latanime:${id}`,
                    type: itemType,
                    name: title,
                    poster: this.resolveURL(poster),
                    year: year?parseInt(year):undefined,
                    genres: genres?[genres]:undefined
                });
            });
            return items;
        } catch(e) {
            console.error('Catalog error:', e.message);
            return [];
        }
    }

    // -----------------------------
    // Meta
    // -----------------------------
    async getMeta(id) {
        try {
            const animeId = id.replace('latanime:','');
            const url = `${this.baseURL}/anime/${animeId}`;
            const res = await this.client.get(url);
            const $ = cheerio.load(res.data);

            const title = $('.anime-title, .title, h1').first().text().trim();
            const poster = $('.anime-poster img, .poster img').attr('src') || $('.anime-poster img, .poster img').attr('data-src');
            const background = $('.anime-bg, .background').attr('style')?.match(/url\(([^)]+)\)/)?.[1];
            const description = $('.synopsis, .description, .summary').text().trim();
            const year = $('.year, .date').text().match(/\d{4}/)?.[0];
            const genres = $('.genre-list .genre, .genres span').map((i,el)=>$(el).text()).get();
            const rating = parseFloat($('.rating, .score').text().match(/[\d.]+/)?.[0]) || undefined;

            return {
                id: `latanime:${animeId}`,
                type: this.determineType(title, genres.join(' ')),
                name: title,
                poster: this.resolveURL(poster),
                background: this.resolveURL(background),
                description,
                year: year?parseInt(year):undefined,
                genres,
                imdbRating: rating
            };
        } catch(e) {
            console.error('Meta error:', e.message);
            return null;
        }
    }

    // -----------------------------
    // Streams (simplified)
    // -----------------------------
    async getStreams(id) {
        try {
            const parts = id.split(':');
            const animeId = parts[1];
            const episodeNum = parts[2] || '1';
            const url = `${this.baseURL}/ver/${animeId}-episodio-${episodeNum}`;
            const res = await this.client.get(url);
            const $ = cheerio.load(res.data);
            const streams = [];

            // Example: extract embedded iframes and video tags
            $('iframe, video source, video').each((i, el) => {
                const $el = $(el);
                let url = $el.attr('src');
                if (!url) return;
                streams.push({
                    url: this.resolveURL(url),
                    title: `${this.extractHostName(url)} ${this.extractQuality($el.text())}`,
                    quality: this.extractQuality($el.text())
                });
            });

            return streams;
        } catch(e) {
            console.error('Streams error:', e.message);
            return [];
        }
    }
}

// -----------------------------
// Initialize addon
// -----------------------------
const builder = new addonBuilder(manifest);
const api = new LatanimeAPI();

builder.defineCatalogHandler(async (args) => {
    const { type, extra } = args;
    const metas = await api.getCatalog(type, extra?.genre, parseInt(extra?.skip)||0, extra?.search);
    return { metas };
});

builder.defineMetaHandler(async (args) => {
    const meta = await api.getMeta(args.id);
    return { meta };
});

builder.defineStreamHandler(async (args) => {
    const streams = await api.getStreams(args.id);
    return { streams };
});

// -----------------------------
// Express server for Render
// -----------------------------
const app = express();
app.use(cors());
const addonInterface = builder.getInterface();
app.use('/', getRouter(addonInterface));

// Health check
app.get('/health', (req,res)=>res.send('OK'));

// Start server
const port = process.env.PORT || 3000;
app.listen(port, ()=>{
    console.log(`Latanime Stremio Addon running on port ${port}`);
    console.log(`Manifest: http://localhost:${port}/manifest.json`);
});
