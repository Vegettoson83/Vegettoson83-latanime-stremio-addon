const { ScrapingBeeClient } = require("scrapingbee");
const NodeCache = require("node-cache");

const LATANIME_URL = "https://latanime.org";
const ITEMS_PER_PAGE = 28;

const SB_API_KEY = process.env.SB_API_KEY;

let sbClient = null;
if (SB_API_KEY) {
    sbClient = new ScrapingBeeClient(SB_API_KEY);
}

const cache = new NodeCache({ stdTTL: 86400 });

async function fetchWithScrapingBee(url, render_js = false, json_response = false) {
    if (!sbClient) {
        if (process.env.SB_API_KEY) {
            sbClient = new ScrapingBeeClient(process.env.SB_API_KEY);
        } else {
            throw new Error("SB_API_KEY environment variable is not set");
        }
    }
    const cacheKey = `${url}:${render_js}:${json_response}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`Cache hit for ${cacheKey}`);
        return cached;
    }

    console.log(`Fetching ${url} via ScrapingBee (JS: ${render_js}, JSON: ${json_response})`);
    try {
        const params = {
            render_js: render_js.toString(),
        };
        if (json_response) {
            params.json_response = 'true';
        }

        const response = await sbClient.get({
            url: url,
            params: params,
        });

        if (response.status !== 200) {
            throw new Error(`ScrapingBee returned status ${response.status}`);
        }

        let data = response.data;

        if (typeof data !== 'string') {
             const decoder = new TextDecoder();
             data = decoder.decode(data);
        }

        cache.set(cacheKey, data);
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
