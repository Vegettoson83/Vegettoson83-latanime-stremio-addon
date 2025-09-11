// stremio-latanime-addon-multiaudio.js
const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

// In-memory cache
const cache = {
  catalog: {}, // { page: [animeList] }
  meta: {},    // { animeId: metaData }
  lastUpdated: 0,
};

// Refresh interval (ms) — 30 minutes
const REFRESH_INTERVAL = 30 * 60 * 1000;

const manifest = {
  id: "latanime.full.addon.multiaudio",
  version: "1.4.0",
  name: "Latanime Stremio Addon Multi-Audio",
  description: "Anime catalog with caching, periodic updates, and separate Latino/Castellano entries",
  resources: ["catalog", "meta", "stream"],
  types: ["series"],
  catalogs: [
    { type: "series", id: "latanime_series", name: "Latanime Series" },
  ],
};

const builder = new addonBuilder(manifest);

// Helper: fetch anime list per page, split by audio track
async function fetchAnimeList(page = 1) {
  const now = Date.now();
  if (cache.catalog[page] && now - cache.lastUpdated < REFRESH_INTERVAL) {
    return cache.catalog[page];
  }

  const url = `https://latanime.org/animes?p=${page}`;
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "StremioAddon" },
  });
  const $ = cheerio.load(data);
  const animeList = [];

  $(".anime-card, .entry-title").each((i, el) => {
    const title = $(el).find(".anime-title, h2.entry-title").text().trim();
    const link = $(el).find("a").attr("href");
    const poster = $(el).find("img").attr("src");

    // Detect audio labels
    const languages = [];
    $(el).find(".audio, .label").each((j, lbl) => {
      const lang = $(lbl).text().trim();
      if (lang) languages.push(lang);
    });
    if (languages.length === 0) languages.push("Latino"); // default

    languages.forEach(lang => {
      animeList.push({
        id: `latanime_${page}_${i}_${lang}`,
        name: `${title} (${lang})`,
        poster,
        link,
        language: lang,
        page,
        index: i,
      });
    });
  });

  cache.catalog[page] = animeList;
  cache.lastUpdated = now;
  return animeList;
}

// Helper: fetch series metadata with caching
async function fetchSeriesDetail(anime) {
  if (cache.meta[anime.id]) return cache.meta[anime.id];

  const { data } = await axios.get(anime.link, {
    headers: { "User-Agent": "StremioAddon" },
  });
  const $ = cheerio.load(data);

  const description = $("p:contains('Sinopsis')").text().trim() || "";
  const genres = [];
  $(".genres a, .btn.btn-default").each((i, el) => {
    genres.push($(el).text().trim());
  });

  const episodes = [];
  $("a").each((i, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (href && text.toLowerCase().includes("capitulo") && text.includes(anime.language)) {
      episodes.push({ title: text, url: href });
    }
  });

  const metaData = { description, genres, episodes };
  cache.meta[anime.id] = metaData;
  return metaData;
}

// Catalog handler
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const page = (extra && extra.page) || 1;
  const list = await fetchAnimeList(page);

  return {
    metas: list.map(anime => ({
      id: anime.id,
      name: anime.name,
      type,
      poster: anime.poster,
      description: `Language: ${anime.language}`,
    })),
    extra: { nextPage: list.length ? page + 1 : null },
  };
});

// Meta handler
builder.defineMetaHandler(async ({ type, id }) => {
  const parts = id.split("_");
  const page = parts[1];
  const index = parts[2];
  const language = parts[3];

  const list = await fetchAnimeList(page);
  const anime = list.find(a => a.language === language && a.index == index);
  if (!anime) return null;

  const detail = await fetchSeriesDetail(anime);

  return {
    id: anime.id,
    name: anime.name,
    type,
    poster: anime.poster,
    description: detail.description || "No description available",
    genres: detail.genres,
    streams: detail.episodes.map(ep => ({
      title: ep.title,
      url: ep.url,
      externalUrl: ep.url,
    })),
  };
});

// Auto-refresh cache
setInterval(() => {
  cache.catalog = {};
  cache.meta = {};
  cache.lastUpdated = Date.now();
  console.log("Latanime addon cache refreshed.");
}, REFRESH_INTERVAL);

module.exports = builder.getInterface();
