const { addonBuilder } = require("stremio-addon-sdk");
const https = require("https");
const cheerio = require("cheerio");

// HTTPS GET function with timeout and redirect handling
function get(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(res.headers.location));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Failed to load page, status code: ${res.statusCode}`));
      }

      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    }).on('error', (err) => {
      reject(err);
    });

    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// Addon Manifest
const manifest = {
  id: "community.latanime",
  version: "0.0.7",
  name: "Latanime",
  description: "Stremio addon for latanime.org - Watch anime with Spanish subtitles",
  resources: ["catalog", "stream", "meta"],
  types: ["series"],
  catalogs: [{
    type: "series",
    id: "latanime-top",
    name: "Latanime - Recent"
  }]
};

const builder = new addonBuilder(manifest);

// Catalog Handler
builder.defineCatalogHandler(async ({ type, id }) => {
  if (type !== "series" || id !== "latanime-top") {
    return Promise.resolve({ metas: [] });
  }

  try {
    const html = await get("https://latanime.org/animes");
    const $ = cheerio.load(html);
    const metas = [];

    const selector = '.col-md-4.col-lg-3.col-xl-2.col-6.my-3';
    $(selector).each((i, el) => {
      const $el = $(el);
      const link = $el.find('a').attr('href');
      const title = $el.find('h3.my-1').text().trim();
      const poster = $el.find('img.lozad').attr('data-src');

      if (link && title) {
        const animeId = link.split('/').pop();
        if (animeId && !metas.some(m => m.id === animeId)) {
          metas.push({
            id: animeId,
            type: "series",
            name: title,
            poster: poster
          });
        }
      }
    });

    return Promise.resolve({ metas });
  } catch (error) {
    console.error('Catalog error:', error);
    return Promise.resolve({ metas: [] });
  }
});

// Meta Handler
builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "series") {
    return Promise.resolve({ meta: null });
  }

  try {
    const html = await get(`https://latanime.org/anime/${id}`);
    const $ = cheerio.load(html);

    const title = $('div.col-lg-9.col-md-8 h2').text().trim();
    const description = $('p.my-2.opacity-75').text().trim();
    const poster = $('div.serieimgficha img').attr('src');

    const genres = [];
    $('a[href^="/genero/"]').each((i, el) => {
      genres.push($(el).text().trim());
    });

    const videos = [];
    $('div[style*="overflow-y: auto"] a.cap-layout').each((i, el) => {
      const $link = $(el);
      const href = $link.attr('href');
      const episodeTitle = $link.text().trim().replace(/\s+/g, ' ');

      if (href) {
        const episodeId = href.split('/').pop();
        const match = episodeTitle.match(/cap[íi]tulo (\d+)/i);
        const episodeNumber = match ? parseInt(match[1], 10) : i + 1;

        videos.push({
          id: episodeId,
          title: episodeTitle,
          season: 1,
          episode: episodeNumber,
          released: new Date()
        });
      }
    });

    const meta = {
      id: id,
      type: "series",
      name: title,
      description: description,
      poster: poster,
      genres: genres,
      videos: videos.reverse()
    };

    return Promise.resolve({ meta });
  } catch (error) {
    console.error('Meta error:', error);
    return Promise.resolve({ meta: null });
  }
});

// Stream Handler
builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "series") {
    return Promise.resolve({ streams: [] });
  }

  try {
    const html = await get(`https://latanime.org/ver/${id}`);
    const $ = cheerio.load(html);

    const providers = $('ul.cap_repro li#play-video > a.play-video');

    const promises = providers.map(async (i, el) => {
      const $provider = $(el);
      const encodedUrl = $provider.attr('data-player');
      const providerName = $provider.text().trim();

      if (!encodedUrl) return null;

      try {
        const decodedUrl = Buffer.from(encodedUrl, 'base64').toString('utf8');
        if (!decodedUrl.startsWith('http')) return null;

        const playerHtml = await get(decodedUrl);
        const $player = cheerio.load(playerHtml);

        let videoUrl = $player('source').attr('src') || $player('video').attr('src');

        if (!videoUrl) {
          const iframeSrc = $player('iframe').attr('src');
          if (iframeSrc) {
            const iframeHtml = await get(iframeSrc);
            const $iframe = cheerio.load(iframeHtml);
            videoUrl = $iframe('source').attr('src') || $iframe('video').attr('src');
          }
        }

        if (videoUrl) {
          if (!videoUrl.startsWith('http')) {
            const baseUrl = new URL(decodedUrl).origin;
            videoUrl = new URL(videoUrl, baseUrl).href;
          }
          return { url: videoUrl, title: providerName };
        }
        return null;
      } catch (err) {
        console.error(`Error processing provider ${providerName}:`, err);
        return null;
      }
    }).get();

    const results = await Promise.all(promises);
    const streams = results.filter(stream => stream !== null);

    return Promise.resolve({ streams });
  } catch (error) {
    console.error('Stream error:', error);
    return Promise.resolve({ streams: [] });
  }
});

module.exports = builder.getInterface();
