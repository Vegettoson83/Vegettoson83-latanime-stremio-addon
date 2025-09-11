
const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

// Addon manifest
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

// Genre mapping from site analysis
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

const builder = new addonBuilder(manifest);

// Utility functions for web scraping
class LatanimeAPI {
    constructor() {
        this.baseURL = 'https://latanime.org';
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
        
        // Configure axios with headers to avoid blocking
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

    // Scrape catalog from main page and directory
    async getCatalog(type, genre, skip = 0, search = '') {
        try {
            let url = `${this.baseURL}/animes`;
            const params = new URLSearchParams();
            
            if (search) {
                // Search functionality
                params.append('search', search);
            }
            
            if (genre && genre !== 'all') {
                params.append('genre', genre);
            }
            
            // Add pagination
            if (skip > 0) {
                params.append('page', Math.floor(skip / 24) + 1);
            }
            
            if (params.toString()) {
                url += '?' + params.toString();
            }
            
            const response = await this.client.get(url);
            const $ = cheerio.load(response.data);
            
            const items = [];
            
            // Parse anime items from the page
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
                    
                    // Filter by type if specified
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
        } catch (error) {
            console.error('Error fetching catalog:', error.message);
            return [];
        }
    }

    // Get detailed metadata for specific anime
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
            
            // Extract episode information
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
            
            // Determine type
            const type = this.determineType(title, genres.join(' '));
            
            return {
                id: `latanime:${animeId}`,
                type: type,
                name: title,
                poster: this.resolveURL(poster),
                background: this.resolveURL(background),
                description: description,
                year: year ? parseInt(year) : undefined,
                genres: genres,
                imdbRating: rating,
                videos: type === 'series' ? videos : undefined
            };
        } catch (error) {
            console.error('Error fetching meta:', error.message);
            return null;
        }
    }

    // Extract streaming links from episode/movie page
    async getStreams(id) {
        try {
            const parts = id.split(':');
            const animeId = parts[1];
            const episodeNum = parts[2] || '1';
            
            // Try different URL patterns
            const possibleUrls = [
                `${this.baseURL}/ver/${animeId}-episodio-${episodeNum}`,
                `${this.baseURL}/ver/${animeId}-${episodeNum}`,
                `${this.baseURL}/ver/${animeId}/episodio-${episodeNum}`,
                `${this.baseURL}/anime/${animeId}/episodio/${episodeNum}`
            ];
            
            let response;
            for (const url of possibleUrls) {
                try {
                    response = await this.client.get(url);
                    break;
                } catch (e) {
                    continue;
                }
            }
            
            if (!response) {
                throw new Error('Could not find episode page');
            }
            
            const $ = cheerio.load(response.data);
            const streams = [];
            
            // Extract video sources using our identified selectors
            await this.extractMegaLinks($, streams);
            await this.extractGoogleDriveLinks($, streams);
            await this.extractMediaFireLinks($, streams);
            await this.extractGenericVideoLinks($, streams);
            
            return streams;
        } catch (error) {
            console.error('Error fetching streams:', error.message);
            return [];
        }
    }

    // Extract MEGA links
    async extractMegaLinks($, streams) {
        $('a[href*="mega.nz"], iframe[src*="mega.nz"]').each((i, element) => {
            const $elem = $(element);
            const url = $elem.attr('href') || $elem.attr('src');
            const quality = this.extractQuality($elem.text() || $elem.parent().text());
            
            if (url) {
                streams.push({
                    url: url,
                    title: `MEGA ${quality}`,
                    quality: quality,
                    behaviorHints: {
                        bingeGroup: 'latanime-mega'
                    }
                });
            }
        });
    }

    // Extract Google Drive links
    async extractGoogleDriveLinks($, streams) {
        $('iframe[src*="drive.google.com"], iframe[src*="googleusercontent.com"]').each((i, element) => {
            const $elem = $(element);
            let url = $elem.attr('src');
            const quality = this.extractQuality($elem.parent().text());
            
            if (url) {
                // Convert to direct streaming URL if it's a preview link
                if (url.includes('/preview')) {
                    url = url.replace('/preview', '/view');
                }
                
                streams.push({
                    url: url,
                    title: `Google Drive ${quality}`,
                    quality: quality,
                    behaviorHints: {
                        bingeGroup: 'latanime-gdrive'
                    }
                });
            }
        });
    }

    // Extract MediaFire links
    async extractMediaFireLinks($, streams) {
        $('a[href*="mediafire.com"]').each((i, element) => {
            const $elem = $(element);
            const url = $elem.attr('href');
            const quality = this.extractQuality($elem.text() || $elem.parent().text());
            
            if (url) {
                streams.push({
                    url: url,
                    title: `MediaFire ${quality}`,
                    quality: quality,
                    behaviorHints: {
                        bingeGroup: 'latanime-mediafire'
                    }
                });
            }
        });
    }

    // Extract generic video links and embedded players
    async extractGenericVideoLinks($, streams) {
        // Look for common streaming service iframes
        const streamingSelectors = [
            'iframe[src*="streamtape.com"]',
            'iframe[src*="doodstream.com"]',
            'iframe[src*="dood."]',
            'iframe[src*="upstream.to"]',
            'iframe[src*="fembed"]',
            'iframe[src*="player"]',
            'iframe[src*="embed"]'
        ];
        
        streamingSelectors.forEach(selector => {
            $(selector).each((i, element) => {
                const $elem = $(element);
                const url = $elem.attr('src');
                const hostName = this.extractHostName(url);
                const quality = this.extractQuality($elem.parent().text()) || '720p';
                
                if (url) {
                    streams.push({
                        url: url,
                        title: `${hostName} ${quality}`,
                        quality: quality,
                        behaviorHints: {
                            bingeGroup: `latanime-${hostName.toLowerCase()}`
                        }
                    });
                }
            });
        });
        
        // Look for direct video elements
        $('video source, video').each((i, element) => {
            const $elem = $(element);
            const url = $elem.attr('src');
            const quality = this.extractQuality($elem.attr('data-quality') || '720p');
            
            if (url) {
                streams.push({
                    url: this.resolveURL(url),
                    title: `Direct ${quality}`,
                    quality: quality,
                    behaviorHints: {
                        bingeGroup: 'latanime-direct'
                    }
                });
            }
        });
    }

    // Helper functions
    extractIdFromUrl(url) {
        if (!url) return null;
        const match = url.match(/\/(?:ver|anime)\/([^\/\?]+)/);
        return match ? match[1] : url.split('/').pop();
    }

    determineType(title, genres) {
        const movieKeywords = ['película', 'movie', 'film', 'pelicula'];
        const lowerTitle = title.toLowerCase();
        const lowerGenres = (genres || '').toLowerCase();
        
        if (movieKeywords.some(keyword => lowerTitle.includes(keyword) || lowerGenres.includes(keyword))) {
            return 'movie';
        }
        
        return 'series';
    }

    extractQuality(text) {
        if (!text) return '720p';
        const qualityMatch = text.match(/(\d{3,4}p|HD|4K|1080|720|480)/i);
        if (qualityMatch) {
            let quality = qualityMatch[1].toUpperCase();
            if (quality === 'HD') return '720p';
            if (quality === '4K') return '2160p';
            if (!quality.includes('p')) quality += 'p';
            return quality;
        }
        return '720p';
    }

    extractHostName(url) {
        if (!url) return 'Unknown';
        try {
            const hostname = new URL(url).hostname;
            return hostname.replace('www.', '').split('.')[0];
        } catch {
            return 'Unknown';
        }
    }

    resolveURL(url) {
        if (!url) return null;
        if (url.startsWith('http')) return url;
        if (url.startsWith('//')) return 'https:' + url;
        if (url.startsWith('/')) return this.baseURL + url;
        return url;
    }
}

// Initialize API
const api = new LatanimeAPI();

// Addon handlers
builder.defineCatalogHandler(async (args) => {
    const { type, id, extra } = args;
    const genre = extra?.genre;
    const skip = parseInt(extra?.skip) || 0;
    const search = extra?.search;
    
    console.log(`Fetching catalog: ${type}, genre: ${genre}, skip: ${skip}, search: ${search}`);
    
    const metas = await api.getCatalog(type, genre, skip, search);
    return { metas };
});

builder.defineMetaHandler(async (args) => {
    const { id } = args;
    console.log(`Fetching meta for: ${id}`);
    
    const meta = await api.getMeta(id);
    return { meta };
});

builder.defineStreamHandler(async (args) => {
    const { id } = args;
    console.log(`Fetching streams for: ${id}`);
    
    const streams = await api.getStreams(id);
    return { streams };
});

// Export addon
module.exports = builder.getInterface();

// For standalone server (optional)
if (require.main === module) {
    const express = require('express');
    const cors = require('cors');
    
    const app = express();
    app.use(cors());
    
    app.use('/', builder.getRouter());
    
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`Latanime Stremio addon running on port ${port}`);
        console.log(`Manifest: http://localhost:${port}/manifest.json`);
    });
}
