const { ScrapingBeeClient } = require("scrapingbee");
const NodeCache = require("node-cache");

const LATANIME_URL = "https://latanime.org";
const ITEMS_PER_PAGE = 28;

const SB_API_KEY = process.env.SCRAPINGBEE_API_KEY;

if (!SB_API_KEY) {
    throw new Error("SCRAPINGBEE_API_KEY is a required environment variable");
}

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

function normalizeId(id) {
    return id.replace(/^latanime-/, '').split('/').filter(x => x).pop().split('?')[0];
}

module.exports = {
    LATANIME_URL,
    ITEMS_PER_PAGE,
    fetchWithScrapingBee,
    normalizeId
};
