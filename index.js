const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

// ─────────────────────────────
// 1. MANIFEST
// ─────────────────────────────
const manifest = {
    id: "org.latanime.complete.stremio",
    version: "1.2.0",
    name: "Latanime Complete (Search-Enabled)",
    description: "Anime streaming from latanime.org with full catalog, meta, and stream support.",
    catalogs: [
        {
            type: "series",
            id: "latanime",
            name: "Latanime Anime",
            extra: [{ name: "search", isRequired: false }]
        }
    ],
    resources: ["catalog", "meta", "stream"],
    types: ["series"],
    idPrefixes: ["latanime_"],
    baseUrl: "YOUR_DEPLOYMENT_URL" // replace before deploying
};
const builder = new addonBuilder(manifest);

// ─────────────────────────────
// 2. Utility
// ─────────────────────────────
function decodeBase64(str) {
    try {
        return Buffer.from(str, "base64").toString("utf8");
    } catch {
        return null;
    }
}

// ─────────────────────────────
// 3. CATALOG HANDLER (supports search)
// ─────────────────────────────
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (type !== "series" || id !== "latanime") return { metas: [] };
    const searchQuery = extra?.search?.toLowerCase() || null;

    try {
        const response = await axios.get("https://latanime.org/");
        const $ = cheerio.load(response.data);
        const metas = [];

        $("a.item.capa").each((_, el) => {
            const url = $(el).attr("href");
            const slugMatch = url.match(/\/anime\/(.+?)\/$/);
            if (!slugMatch) return;

            const slug = slugMatch[1];
            const name = $(el).find(".text-center").text().trim();
            const poster = $(el).find("img").attr("data-src");

            if (!searchQuery || name.toLowerCase().includes(searchQuery)) {
                metas.push({
                    id: `latanime_${slug}`,
                    type: "series",
                    name: name || slug.replace(/-/g, " ").toUpperCase(),
                    poster: poster,
                    description: `Anime from Latanime.org`
                });
            }
        });

        return { metas: metas.slice(0, 50) }; // limit for performance
    } catch (error) {
        console.error("Catalog extraction failed:", error.message);
        return { metas: [] };
    }
});

// ─────────────────────────────
// 4. META HANDLER
// ─────────────────────────────
builder.defineMetaHandler(async ({ id }) => {
    const slug = id.replace("latanime_", "");
    const animeUrl = `https://latanime.org/anime/${slug}/`;

    try {
        const response = await axios.get(animeUrl);
        const $ = cheerio.load(response.data);
        const videos = [];

        $("ul.list_series li a").each((_, el) => {
            const epLink = $(el).attr("href");
            const epNumMatch = epLink.match(/episodio-(\d+)/);
            if (!epNumMatch) return;

            const epNum = parseInt(epNumMatch[1]);
            const title = $(el).text().trim() || `Episodio ${epNum}`;

            videos.push({
                id: `${id}_ep${epNum}`,
                title,
                episode: epNum,
                season: 1,
                released: new Date().toISOString()
            });
        });

        videos.reverse();
        const name = $(".header h1").text().trim() || slug.replace(/-/g, " ");
        const poster = $(".capa img").attr("data-src");
        const description = $("p.sinopsis").text().trim() || "Sinopsis no disponible.";

        return {
            meta: { id, type: "series", name, poster, description, videos }
        };
    } catch (error) {
        console.error(`Meta extraction failed for ${slug}:`, error.message);
        return {
            meta: { id, type: "series", name: slug.replace(/-/g, " "), videos: [] }
        };
    }
});

// ─────────────────────────────
// 5. STREAM HANDLER
// ─────────────────────────────
builder.defineStreamHandler(async ({ id }) => {
    const m = id.match(/latanime_(.+)_ep(\d+)/);
    if (!m) return { streams: [] };

    const [_, animeSlug, epNum] = m;
    const epUrl = `https://latanime.org/ver/${animeSlug}-episodio-${epNum}`;

    try {
        const response = await axios.get(epUrl);
        const $ = cheerio.load(response.data);
        const streams = [];

        $("div.servers a[data-player]").each((_, el) => {
            const dataPlayer = $(el).attr("data-player");
            const name = $(el).text().trim() || "Server";
            const url = decodeBase64(dataPlayer);

            if (url) {
                streams.push({
                    name: `LATANIME :: ${name.toUpperCase()}`,
                    url,
                    title: `Latino Source: ${name}`
                });
            }
        });

        return { streams };
    } catch (error) {
        console.error("Stream extraction failed:", error.message);
        return { streams: [] };
    }
});

// ─────────────────────────────
// 6. EXPORT + LOCAL SERVER
// ─────────────────────────────
module.exports = builder.getInterface();

if (require.main === module) {
    const PORT = process.env.PORT || 7000;
    serveHTTP(builder.getInterface(), { port: PORT });
    console.log(`✅ Latanime Addon running on http://localhost:${PORT}/manifest.json`);
}
