const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const BASE_URL = 'https://latanime.org';

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': BASE_URL
};

async function searchAnime(query) {
    try {
        const response = await axios.get(`${BASE_URL}/buscar?q=${encodeURIComponent(query)}`, { headers });
        const $ = cheerio.load(response.data);
        const results = [];

        $('div[class^="col-"] a[href*="/anime/"]').each((i, el) => {
            const href = $(el).attr('href');
            const title = $(el).find('h3').text().trim() || $(el).text().trim();
            const img = $(el).find('img').attr('src');

            if (href) {
                const slug = href.split('/').pop();
                results.push({
                    id: `latanime-${slug}`,
                    name: title,
                    poster: img.startsWith('http') ? img : `${BASE_URL}${img}`,
                    type: 'series'
                });
            }
        });

        return results;
    } catch (error) {
        console.error('Error in searchAnime:', error.message);
        return [];
    }
}

async function getRecentAnime() {
    try {
        const response = await axios.get(BASE_URL, { headers });
        const $ = cheerio.load(response.data);
        const results = [];

        // "Series recientes" section
        const section = $('h2:contains("Series recientes")').next('ul');
        section.find('li article a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('/anime/')) {
                const title = $(el).find('h3').text().trim();
                const img = $(el).find('img');
                const poster = img.attr('data-src') || img.attr('src');
                const slug = href.split('/').pop();

                results.push({
                    id: `latanime-${slug}`,
                    name: title,
                    poster: poster.startsWith('http') ? poster : `${BASE_URL}${poster}`,
                    type: 'series'
                });
            }
        });

        return results;
    } catch (error) {
        console.error('Error in getRecentAnime:', error.message);
        return [];
    }
}

async function getAnimeDetails(slug) {
    try {
        const response = await axios.get(`${BASE_URL}/anime/${slug}`, { headers });
        const $ = cheerio.load(response.data);

        const title = $('h2').first().text().trim();
        const poster = $('.serieimgficha img').attr('src');
        const description = $('p.my-2.opacity-75').text().trim();

        const episodes = [];
        $('a[href*="/ver/"]').each((i, el) => {
            const href = $(el).attr('href');
            const epTitle = $(el).text().trim().replace(/\s+/g, ' ');

            if (href) {
                const epSlug = href.split('/').pop();
                // Try to extract episode number
                const epMatch = epSlug.match(/episodio-(\d+)/);
                const episodeNum = epMatch ? parseInt(epMatch[1]) : (i + 1);

                episodes.push({
                    id: `latanime-${epSlug}`,
                    title: epTitle,
                    season: 1, // Addon usually deals with single season per slug on these sites
                    episode: episodeNum,
                    released: new Date().toISOString()
                });
            }
        });

        // Sort episodes ascending
        episodes.sort((a, b) => a.episode - b.episode);

        return {
            id: `latanime-${slug}`,
            name: title,
            poster: poster.startsWith('http') ? poster : `${BASE_URL}${poster}`,
            description,
            type: 'series',
            videos: episodes
        };
    } catch (error) {
        console.error('Error in getAnimeDetails:', error.message);
        return null;
    }
}

async function getEpisodeStreams(epSlug) {
    try {
        const response = await axios.get(`${BASE_URL}/ver/${epSlug}`, { headers });
        const $ = cheerio.load(response.data);
        const providers = [];

        $('a.play-video').each((i, el) => {
            const name = $(el).text().trim();
            const encodedPlayer = $(el).attr('data-player');
            if (encodedPlayer) {
                const embedUrl = Buffer.from(encodedPlayer, 'base64').toString();
                providers.push({
                    name,
                    url: embedUrl
                });
            }
        });

        // Add download links as well
        const dlSelectors = [
            'a[href*="pixeldrain.com"]', 'a[href*="mediafire.com"]', 'a[href*="mega.nz"]',
            'a[href*="gofile.io"]', 'a[href*="drive.google.com"]', 'a[href*="1fichier.com"]'
        ];
        $(dlSelectors.join(',')).each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                providers.push({
                    name: `Download ${$(el).text().trim() || i}`,
                    url: href,
                    isDownload: true
                });
            }
        });

        return providers;
    } catch (error) {
        console.error('Error in getEpisodeStreams:', error.message);
        return [];
    }
}

async function extractDirectUrl(embedUrl) {
    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        let directUrl = null;

        // Listen for video requests
        page.on('request', request => {
            const url = request.url();
            try {
                const isVideo = url.match(/\.(m3u8|mp4|ts)(\?|$)/i) &&
                                !url.includes('analytics') &&
                                !url.includes('doubleclick') &&
                                !url.includes('google');

                if (isVideo) {
                    directUrl = url;
                }
            } catch (e) {}
        });

        // Block unnecessary resources to speed up
        await page.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2}', route => route.abort());

        await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Try to click play if needed
        const playSelectors = ['#vplayer', '.jw-display-icon-container', 'video', 'body', '.play-button'];
        for (const selector of playSelectors) {
            if (directUrl) break;
            try {
                const btn = await page.$(selector);
                if (btn) {
                    await btn.click({ force: true, timeout: 2000 }).catch(() => {});
                    // Wait a bit after click
                    await page.waitForTimeout(1000);
                }
            } catch (e) {}
        }

        // Final wait for network
        let attempts = 0;
        while (!directUrl && attempts < 5) {
            await page.waitForTimeout(1000);
            attempts++;
        }

        return directUrl;
    } catch (error) {
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = {
    searchAnime,
    getRecentAnime,
    getAnimeDetails,
    getEpisodeStreams,
    extractDirectUrl
};
