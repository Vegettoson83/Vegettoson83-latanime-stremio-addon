// LatAnime Personal Addon
// Supports Series + Movies

const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

// Manifest
const manifest = {
    id: "org.latanime.addon",
    version: "4.0.0",
    name: "LatAnime.org",
    description: "Browse and stream anime series + movies from LatAnime.org",
    types: ["series", "movie"],
    catalogs: [
        {
            type: "series",
            id: "latanime_catalog",
            name: "LatAnime Series",
            extra: [
                { name: "search", isRequired: false },
                { name: "skip", isRequired: false }
            ]
        },
        {
            type: "movie",
            id: "latanime_movies",
            name: "LatAnime Movies",
            extra: [
                { name: "search", isRequired: false },
                { name: "skip", isRequired: false }
            ]
        }
    ],
    resources: ["catalog", "meta", "stream"],
    idPrefixes: ["latanime:"]
};

const builder = new addonBuilder(manifest);

// ---------- Helpers ----------
function normalizeHost(url) {
    const hostDomains = [
        'filemoon','mixdrop','doodstream','dood','mega','mp4upload',
        'yourupload','uqload','lulu','listeamed','voe','ok','playerwish'
    ];
    const lower = url.toLowerCase();
    for (let hd of hostDomains) {
        if (lower.includes(hd)) return hd === "dood" ? "doodstream" : hd;
    }
    return "unknown";
}

// ---------- STREAM SCRAPER ----------
async function extractStreamsFromEpisode(slug, episodeNum) {
    const url = `https://latanime.org/ver/${slug}-episodio-${episodeNum}`;
    try {
        const res = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        const $ = cheerio.load(res.data);
        const streams = [];

        $("a, iframe").each((i, el) => {
            const href = $(el).attr("href") || $(el).attr("src");
            if (!href) return;
            const host = normalizeHost(href);
            if (host !== "unknown") {
                streams.push({
                    url: href,
                    title: `LatAnime (${host})`,
                    quality: "720p",
                    behaviorHints: { bingeGroup: `latanime-${host}` }
                });
            }
        });

        // Deduplicate
        const seen = new Set();
        return streams.filter(s => !seen.has(s.url) && seen.add(s.url));
    } catch (e) {
        console.error("Stream error:", e.message);
        return [];
    }
}

// ---------- CATALOG SCRAPER ----------
async function fetchCatalog(type, { search, skip = 0 }) {
    let url;
    if (search) {
        url = `https://latanime.org/?s=${encodeURIComponent(search)}`;
    } else {
        const page = Math.floor(skip / 20) + 1;
        url = type === "movie"
            ? `https://latanime.org/peliculas/page/${page}`
            : `https://latanime.org/page/${page}`;
    }

    try {
        const res = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        const $ = cheerio.load(res.data);
        const metas = [];

        $(".animepost").each((i, el) => {
            const link = $(el).find("a").attr("href");
            const title = $(el).find(".title").text().trim();
            const poster = $(el).find("img").attr("src");
            if (!link || !title) return;

            const slug = link.split("/").filter(Boolean).pop();
            metas.push({
                id: `latanime:${slug}`,
                type,
                name: title,
                poster,
                posterShape: "regular",
                background: poster
            });
        });
        return metas;
    } catch (e) {
        console.error("Catalog error:", e.message);
        return [];
    }
}

// ---------- META SCRAPER ----------
async function fetchMeta(slug) {
    const url = `https://latanime.org/anime/${slug}`;
    try {
        const res = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        const $ = cheerio.load(res.data);

        const title = $(".data h1").text().trim() || $("h1").first().text().trim();
        const poster = $(".poster img").attr("src") || $("img").first().attr("src");
        const description = $(".wp-content p").first().text().trim();
        const genres = [];
        $(".genres a").each((i, el) => genres.push($(el).text().trim()));
        const year = $(".ninfo .info:nth-child(2)").text().match(/\d{4}/)?.[0];

        // Check if it's movie or series
        const isMovie = /pelicul/i.test(title) || genres.includes("Película");

        // Episodes only if series
        const videos = [];
        if (!isMovie) {
            $(".episodios li a").each((i, el) => {
                const epNum = $(el).text().match(/\d+/)?.[0] || (i + 1).toString();
                videos.push({
                    id: `latanime:${slug}:${epNum}`,
                    title: `Episode ${epNum}`
                });
            });
        }

        return {
            id: `latanime:${slug}`,
            type: isMovie ? "movie" : "series",
            name: title,
            poster,
            background: poster,
            description,
            year: year ? parseInt(year) : undefined,
            genres,
            videos: isMovie ? undefined : videos
        };
    } catch (e) {
        console.error("Meta error:", e.message);
        return null;
    }
}

// ---------- HANDLERS ----------
builder.defineCatalogHandler(async ({ type, extra }) => {
    const metas = await fetchCatalog(type, extra || {});
    return { metas };
});

builder.defineMetaHandler(async ({ id }) => {
    const slug = id.split(":")[1];
    const meta = await fetchMeta(slug);
    return { meta };
});

builder.defineStreamHandler(async ({ id }) => {
    const parts = id.split(":");
    const slug = parts[1];
    const episodeNum = parts[2] || "1";
    const streams = await extractStreamsFromEpisode(slug, episodeNum);
    return { streams };
});

module.exports = builder.getInterface();
