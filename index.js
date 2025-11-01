const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

// --- 1. MANIFEST ---
const manifest = {
  id: "org.latanime.dynamic",
  version: "1.0.0",
  name: "Latanime Dynamic",
  description: "Anime streaming from latanime.org, fully dynamic without Puppeteer.",
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
  idPrefixes: ["latanime_"]
};

const builder = new addonBuilder(manifest);

// --- 2. Helper: decode Base64 ---
function decodeBase64(str) {
  try {
    return Buffer.from(str, "base64").toString("utf8");
  } catch {
    return null;
  }
}

// --- 3. Catalog Handler ---
builder.defineCatalogHandler(async ({ extra }) => {
  try {
    const searchQuery = extra?.search?.toLowerCase() || null;
    const res = await axios.get("https://latanime.org/");
    const $ = cheerio.load(res.data);
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
          name: name || slug.replace(/-/g, " "),
          poster,
          description: `Anime from Latanime.org`
        });
      }
    });

    return { metas: metas.slice(0, 50) };
  } catch (err) {
    console.error("Catalog extraction failed:", err.message);
    return { metas: [] };
  }
});

// --- 4. Meta Handler ---
builder.defineMetaHandler(async ({ id }) => {
  const slug = id.replace("latanime_", "");
  const animeUrl = `https://latanime.org/anime/${slug}/`;

  try {
    const res = await axios.get(animeUrl);
    const $ = cheerio.load(res.data);
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

    return { meta: { id, type: "series", name, poster, description, videos } };
  } catch (err) {
    console.error(`Meta extraction failed for ${slug}:`, err.message);
    return { meta: { id, type: "series", name: slug.replace(/-/g, " "), videos: [] } };
  }
});

// --- 5. Stream Handler ---
builder.defineStreamHandler(async ({ id }) => {
  const m = id.match(/latanime_(.+)_ep(\d+)/);
  if (!m) return { streams: [] };

  const [_, animeSlug, epNum] = m;
  const epUrl = `https://latanime.org/ver/${animeSlug}-episodio-${epNum}`;

  try {
    const res = await axios.get(epUrl);
    const $ = cheerio.load(res.data);
    const streams = [];

    // Extract Base64 players
    $("[data-player]").each((_, el) => {
      const src = decodeBase64($(el).attr("data-player"));
      if (src) streams.push({ url: src, name: $(el).text().trim() || "embed" });
    });

    // Extract iframe and known hosts
    $("a, iframe").each((_, el) => {
      const url = $(el).attr("href") || $(el).attr("src");
      if (!url) return;
      if (/pixeldrain|mega|mediafire|gofile|cloud|filemoon|mp4upload|lulu|dsvplay|listeamed|voe|uqload|ok|bembed/.test(url))
        streams.push({ url, name: $(el).text().trim() || "direct" });
    });

    return { streams };
  } catch (err) {
    console.error("Stream extraction failed:", err.message);
    return { streams: [] };
  }
});

// --- 6. Export ---
module.exports = builder.getInterface();
