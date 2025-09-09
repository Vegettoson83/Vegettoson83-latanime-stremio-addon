const { addonBuilder } = require("stremio-addon-sdk");
const https = require("https");
const cheerio = require("cheerio");

// Utility to fetch HTML (supports redirects)
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        resolve(get(response.headers.location));
      } else if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error("Failed to load page, status code: " + response.statusCode));
      } else {
        const body = [];
        response.on("data", (chunk) => body.push(chunk));
        response.on("end", () => resolve(body.join("")));
      }
    }).on("error", (err) => reject(err));
  });
}

// Manifest
const manifest = {
  id: "community.latanime",
  version: "0.0.1",
  name: "Latanime",
  description: "Stremio addon for latanime.org",
  resources: ["catalog", "meta", "stream"],
  types: ["series"],
  catalogs: [
    {
      type: "series",
      id: "latanime-top",
      name: "Latanime"
    }
  ]
};

const builder = new addonBuilder(manifest);

// Catalog handler
builder.defineCatalogHandler(async ({ type, id }) => {
  if (type === "series" && id === "latanime-top") {
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
          poster: img
        });
      }
    });

    return { metas };
  }
  return { metas: [] };
});

// Meta handler
builder.defineMetaHandler(async ({ type, id }) => {
  if (type === "series") {
    const html = await get(`https://latanime.org/anime/${id}`);
    const $ = cheerio.load(html);

    const title = $(".titulo-anime").text();
    const description = $(".sinopsis").text().trim();
    const poster = $(".anime-single-left img").attr("src");

    const genres = [];
    $(".anime-single-right .generos a").each((i, el) => {
      genres.push($(el).text());
    });

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
          released: new Date()
        });
      }
    });

    return {
      meta: {
        id,
        type: "series",
        name: title,
        poster,
        description,
        genres,
        videos: videos.reverse()
      }
    };
  }
  return { meta: null };
});

// Stream handler
builder.defineStreamHandler(async ({ type, id }) => {
  if (type === "series") {
    const html = await get(`https://latanime.org/ver/${id}`);
    const $ = cheerio.load(html);

    const streams = [];
    $(".cap_repro .play-video").each(async (i, el) => {
      const encodedUrl = $(el).attr("data-player");
      if (encodedUrl) {
        try {
          const decodedUrl = Buffer.from(encodedUrl, "base64").toString("utf8");
          const playerHtml = await get(decodedUrl);
          const $$ = cheerio.load(playerHtml);
          const videoUrl = $$("source").attr("src");

          if (videoUrl) {
            streams.push({
              url: videoUrl,
              title: $(el).text().trim()
            });
          }
        } catch (e) {
          console.error("Error fetching stream:", e);
        }
      }
    });

    return { streams };
  }
  return { streams: [] };
});

// ✅ Export the AddonInterface directly
module.exports = builder.getInterface();
