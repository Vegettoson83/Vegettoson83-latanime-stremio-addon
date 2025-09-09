const { addonBuilder } = require("stremio-addon-sdk");
const https = require("https");
const cheerio = require("cheerio");

// Simple HTTPS GET helper with redirect support
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(get(res.headers.location));
      } else if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error("Failed to load page, status code: " + res.statusCode));
      } else {
        const body = [];
        res.on("data", (chunk) => body.push(chunk));
        res.on("end", () => resolve(body.join("")));
      }
    }).on("error", reject);
  });
}

// Addon manifest
const manifest = {
  id: "community.latanime",
  version: "0.0.1",
  name: "Latanime",
  description: "Stremio addon for latanime.org",
  resources: ["catalog", "stream", "meta"],
  types: ["series"],
  catalogs: [{ type: "series", id: "latanime-top", name: "Latanime" }],
};

const builder = new addonBuilder(manifest);

// Catalog handler
builder.defineCatalogHandler(async ({ type, id }) => {
  if (type !== "series" || id !== "latanime-top") return { metas: [] };

  const html = await get("https://latanime.org/animes");
  const $ = cheerio.load(html);

  const metas = [];
  $(".animes .col-6").each((i, el) => {
    const a = $(el).find("a");
    const title = a.attr("title");
    const href = a.attr("href");
    const img = a.find("img").attr("src");
    if (title && href && img) {
      metas.push({
        id: href.split("/").pop(),
        type: "series",
        name: title,
        poster: img,
      });
    }
  });

  return { metas };
});

// Meta handler
builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "series") return { meta: null };

  const html = await get(`https://latanime.org/anime/${id}`);
  const $ = cheerio.load(html);

  const title = $(".titulo-anime").text();
  const description = $(".sinopsis").text().trim();
  const poster = $(".anime-single-left img").attr("src");

  const genres = [];
  $(".anime-single-right .generos a").each((i, el) => genres.push($(el).text()));

  const videos = [];
  $(".episodes-list .col-6").each((i, el) => {
    const a = $(el).find("a");
    const episodeTitle = a.attr("title");
    const href = a.attr("href");
    if (episodeTitle && href) {
      const episodeId = href.split("/").pop();
      const match = episodeTitle.match(/Capitulo (\d+)/);
      const episodeNumber = match ? parseInt(match[1]) : i + 1;
      videos.push({
        id: episodeId,
        title: episodeTitle,
        season: 1,
        episode: episodeNumber,
        released: new Date(),
      });
    }
  });

  return { meta: { id, type: "series", name: title, poster, description, genres, videos: videos.reverse() } };
});

// Stream handler (fixed async)
builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "series") return { streams: [] };

  const html = await get(`https://latanime.org/ver/${id}`);
  const $ = cheerio.load(html);

  const providers = $(".cap_repro .play-video").toArray();

  const streams = await Promise.all(
    providers.map(async (el) => {
      const encodedUrl = $(el).attr("data-player");
      if (!encodedUrl) return null;
      try {
        const decodedUrl = Buffer.from(encodedUrl, "base64").toString("utf8");
        const playerHtml = await get(decodedUrl);
        const $$ = cheerio.load(playerHtml);
        const videoUrl = $$("source").attr("src");
        if (videoUrl) return { url: videoUrl, title: $(el).text().trim() };
      } catch (e) {
        console.error("Error fetching stream:", e);
      }
      return null;
    })
  );

  return { streams: streams.filter(Boolean) };
});

// Export AddonInterface
const addonInterface = builder.getInterface();

// Wrap in a CORS handler for Stremio Web (optional for Render)
module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Origin, X-Requested-With");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    return res.end();
  }

  return addonInterface(req, res);
};
