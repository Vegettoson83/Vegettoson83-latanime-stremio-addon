const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

/* -------------- 1. CONFIGURATION -------------- */
const BASE = 'https://latanime.org';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const axiosCfg = { headers: { 'User-Agent': UA }, timeout: 8000 };

/* -------------- 2. HELPERS -------------- */
const log = (...a) => console.log('[Latanime]', ...a);

const $get = async url => {
  const { data } = await axios.get(url, axiosCfg);
  return cheerio.load(data);
};

const manifest = {
    "id": "org.latanime-sdk.stremio",
    "version": "1.0.0",
    "name": "Latanime (SDK)",
    "description": "Stremio addon for Latanime, providing streams from all available hosts.",
    "types": ["series"],
    "catalogs": [
        {
            "type": "series",
            "id": "latanime-latest",
            "name": "Latanime Latest"
        }
    ],
    "resources": ["catalog", "meta", "stream"],
    "idPrefixes": ["latanime-"]
};

const builder = new addonBuilder(manifest);

/* -------------- 3. CATALOG -------------- */
builder.defineCatalogHandler(async ({ type, id }) => {
  if (type !== 'series' || id !== 'latanime-latest') return { metas: [] };

  const $ = await $get(BASE).catch(() => { log('homepage unreachable'); return null; });
  if (!$) return { metas: [] };

  const metas = [];
  $('article').each((_, el) => {
    const href = $(el).find('a').attr('href');
    if (!href?.includes('/anime/')) return;
    const animeId = href.split('/').pop();
    const title   = $(el).find('h3').text().trim();
    const poster  = $(el).find('img').attr('data-src');
    if (animeId && title) metas.push({
      id: `latanime-${animeId}`,
      type: 'series',
      name: title,
      poster: poster || null
    });
  });
  log(`catalog: ${metas.length} items`);
  return { metas };
});

/* -------------- 4. META -------------- */
builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== 'series') return { meta: {} };
  const slug = id.replace('latanime-', '');
  const $ = await $get(`${BASE}/anime/${slug}`).catch(() => null);
  if (!$) return { meta: {} };

  const videos = [];
  $('a[href*="/ver/"]').each((_, el) => {
    const txt = $(el).text().trim();
    const m   = txt.match(/Cap[ií]tulo\s+(\d+)/i);
    if (m) videos.push({
      season : 1,
      episode: parseInt(m[1], 10),
      title  : txt,
      id     : `${id}:1:${m[1]}`
    });
  });

  const meta = {
    id,
    type: 'series',
    name: $('h2').first().text().trim() || slug,
    poster: $('.serieimgficha img').attr('src') || null,
    videos: videos.reverse()
  };
  log(`meta: ${slug} -> ${videos.length} episodes`);
  return { meta };
});

/* -------------- 5. STREAMS -------------- */
builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'series') return { streams: [] };
  const [animeId, season, episode] = id.split(':');
  const slug = animeId.replace('latanime-', '');
  const url  = `${BASE}/ver/${slug}-episodio-${episode}`;

  const $ = await $get(url).catch(() => null);
  if (!$) return { streams: [] };

  const streams = [];
  $('a.play-video').each((_, el) => {
    const enc = $(el).attr('data-player');
    if (!enc) return;
    try {
      const raw = Buffer.from(enc, 'base64').toString('utf-8').trim();
      if (!raw) return;
      streams.push({
        name : 'Latanime',
        title: $(el).text().trim() || `Server ${streams.length + 1}`,
        url  : raw
      });
    } catch (_) { /* ignore b64 garbage */ }
  });
  log(`streams: ${slug} E${episode} -> ${streams.length} links`);
  return { streams };
});

module.exports = builder.getInterface();
