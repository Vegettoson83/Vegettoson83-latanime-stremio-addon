const { addonBuilder } = require("stremio-addon-sdk");
const https = require("https");
const cheerio = require("cheerio");

function get(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(res.headers.location, timeout));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || "Request failed"}`));
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve(Buffer.concat(chunks).toString("utf8"));
        } catch (error) {
          reject(new Error("Failed to parse response"));
        }
      });
      res.on("error", reject);
    });

    request.on("timeout", () => {
      request.destroy();
      reject(new Error("Request timeout"));
    });
    request.on("error", reject);
  });
}

const builder = new addonBuilder({
  id: "community.latanime",
  version: "0.0.3",
  name: "Latanime",
  description: "Stremio addon for latanime.org - Watch anime with Spanish subtitles",
  resources: ["catalog", "stream", "meta"],
  types: ["series"],
  catalogs: [
    {
      type: "series",
      id: "latanime-recent",
      name: "Latanime - Recent",
      extra: [{ name: "skip", isRequired: false }],
    },
  ],
});

// Catalog
builder.defineCatalogHandler(async ({ type, id }) => {
  if (type !== "series" || id !== "latanime-recent") return { metas: [] };

  try {
    const html = await get("https://latanime.org/animes");
    const $ = cheerio.load(html);
    const metas = [];

    $(".animes .col-6, .animes .col, .anime-item").each((i, el) => {
      const $el = $(el);
      const $link = $el.find("a").first();
      const $img = $link.find("img");

      const title =
        $link.attr("title") || $img.attr("alt") || $link.text().trim();
      const href = $link.attr("href");
      let poster = $img.attr("src") || $img.attr("data-src");

      if (!title || !href) return;

      const idMatch = href.match(/\/anime\/([^\/]+)/);
      const animeId = idMatch ? idMatch[1] : href.split("/").pop();

      if (poster && !poster.startsWith("http")) {
        poster = poster.startsWith("/")
          ? `https://latanime.org${poster}`
          : `https://latanime.org/${poster}`;
      }

      metas.push({
        id: animeId,
        type: "series",
        name: title,
        poster: poster || undefined,
        background: poster || undefined,
      });
    });

    return { metas: metas.slice(0, 100) };
  } catch (err) {
    console.error("Catalog error:", err.message);
    return { metas: [] };
  }
});

// Meta
builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "series") return { meta: null };

  try {
    const html = await get(`https://latanime.org/anime/${encodeURIComponent(id)}`);
    const $ = cheerio.load(html);

    const title = $(".titulo-anime, h1").first().text().trim() || id;
    const description =
      $(".sinopsis, .description").first().text().trim() ||
      "No description available";

    let poster = $(".anime-single-left img, .poster img").first().attr("src");
    if (poster && !poster.startsWith("http")) {
      poster = poster.startsWith("/")
        ? `https://latanime.org${poster}`
        : `https://latanime.org/${poster}`;
    }

    const genres = [];
    $(".generos a").each((i, el) => {
      const genre = $(el).text().trim();
      if (genre) genres.push(genre);
    });

    const videos = [];
    $(".episodes-list a, .episode-list a, .episodes a").each((i, el) => {
      const $el = $(el);
      const href = $el.attr("href");
      const episodeTitle = $el.attr("title") || $el.text().trim();
      if (!href || !episodeTitle) return;

      const episodeId = href.split("/").pop();
      let episodeNumber = i + 1;
      const numberMatch = episodeTitle.match(/(\d+)/);
      if (numberMatch) episodeNumber = parseInt(numberMatch[1]);

      videos.push({
        id: episodeId,
        title: episodeTitle,
        season: 1,
        episode: episodeNumber,
        released: new Date().toISOString(),
      });
    });

    return {
      meta: {
        id,
        type: "series",
        name: title,
        description,
        genres: genres.length ? genres : undefined,
        poster,
        background: poster,
        videos: videos.reverse(),
      },
    };
  } catch (err) {
    console.error("Meta error:", err.message);
    return { meta: null };
  }
});

// Streams
builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "series") return { streams: [] };

  try {
    const html = await get(`https://latanime.org/ver/${encodeURIComponent(id)}`);
    const $ = cheerio.load(html);
    const streams = [];

    $("[data-player], .player-option, .play-video").each((i, el) => {
      try {
        const encodedUrl = $(el).attr("data-player") || $(el).attr("data-url");
        const playerName = $(el).text().trim() || `Player ${i + 1}`;
        if (!encodedUrl) return;

        const decodedUrl = Buffer.from(encodedUrl, "base64").toString("utf8");
        if (decodedUrl.startsWith("http")) {
          streams.push({
            url: decodedUrl,
            title: playerName,
            behaviorHints: { bingeGroup: `latanime-${id}` },
          });
        }
      } catch (err) {
        console.warn("Player error:", err.message);
      }
    });

    return { streams: streams.slice(0, 10) };
  } catch (err) {
    console.error("Stream error:", err.message);
    return { streams: [] };
  }
});

module.exports = builder.getInterface();
