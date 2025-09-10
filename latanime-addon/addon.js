const { addonBuilder } = require("stremio-addon-sdk");
const https = require("https");
const cheerio = require("cheerio");

// Simple HTTPS GET function with timeout
function get(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(res.headers.location));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
    request.on('error', reject);
  });
}

// Create the addon builder
const manifest = {
  id: "community.latanime",
  version: "0.0.5", // incremented version
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

// Catalog handler with a reliable selector
builder.defineCatalogHandler(async ({ type, id }) => {
  console.log(`📚 Catalog request: ${type}/${id}`);
  
  if (type !== "series" || id !== "latanime-top") {
    return { metas: [] };
  }

  try {
    console.log('🔍 Fetching latanime.org/animes...');
    const html = await get("https://latanime.org/animes");
    const $ = cheerio.load(html);
    const metas = [];

    // Use the verified selector for anime cards
    const selector = '.animes .col-6';
    console.log(`🔍 Using selector: ${selector}`);
    const elements = $(selector);
    console.log(`📊 Found ${elements.length} elements with selector: ${selector}`);
    
    elements.each((i, el) => {
      try {
        const $el = $(el);
        const $link = $el.find('a').first();
        const title = $link.attr('title') || $link.text().trim();
        const href = $link.attr('href');
        const poster = $el.find('img').attr('data-src') || $el.find('img').attr('src');
        
        if (!title || !href || title.length < 2) {
          return;
        }

        const animeId = href.split('/').pop();
        
        if (!animeId) {
          return;
        }

        if (metas.find(m => m.id === animeId)) {
          return; // Skip duplicates
        }
        
        metas.push({
          id: animeId,
          type: "series",
          name: title,
          poster: poster
        });
      } catch (itemError) {
        console.warn('⚠️  Error parsing item:', itemError.message);
      }
    });

    console.log(`📚 Final result: Found ${metas.length} anime titles`);
    return { metas };
    
  } catch (error) {
    console.error('❌ Catalog error:', error.message);
    return { metas: [] };
  }
});

// Meta handler with reliable selectors
builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`📄 Meta request: ${type}/${id}`);
  
  if (type !== "series") {
    return { meta: null };
  }

  try {
    const html = await get(`https://latanime.org/anime/${encodeURIComponent(id)}`);
    const $ = cheerio.load(html);

    const title = $('.titulo-anime').first().text().trim();
    const description = $('.sinopsis').first().text().trim();
    const poster = $('.anime-single-left img').first().attr('src');
    
    const genres = [];
    $('.anime-single-right .generos a').each((i, el) => {
      const genre = $(el).text().trim();
      if (genre) {
        genres.push(genre);
      }
    });

    const videos = [];
    $('.episodes-list .col-6 a').each((i, el) => {
      try {
        const $link = $(el);
        const episodeTitle = $link.attr('title') || $link.text().trim();
        const href = $link.attr('href');
        
        if (episodeTitle && href) {
          const episodeId = href.split('/').pop();
          const match = episodeTitle.match(/cap[íi]tulo (\d+)/i);
          const episodeNumber = match ? parseInt(match[1]) : i + 1;
          
          videos.push({
            id: episodeId,
            title: episodeTitle,
            season: 1,
            episode: episodeNumber,
            released: new Date().toISOString()
          });
        }
      } catch (episodeError) {
        console.warn('⚠️  Episode parse error:', episodeError.message);
      }
    });

    const meta = {
      id,
      type: "series",
      name: title || id,
      description,
      genres,
      poster,
      videos: videos.reverse()
    };

    console.log(`📄 Meta found: ${meta.name} with ${videos.length} episodes`);
    return { meta };

  } catch (error) {
    console.error(`❌ Meta error for ${id}:`, error.message);
    return { meta: null };
  }
});

// Stream handler with corrected parallel fetching
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`🎬 Stream request: ${type}/${id}`);
  
  if (type !== "series") {
    return { streams: [] };
  }

  try {
    const html = await get(`https://latanime.org/ver/${encodeURIComponent(id)}`);
    const $ = cheerio.load(html);

    const providers = $('ul.cap_repro li#play-video > a.play-video');
    console.log(`📺 Found ${providers.length} video providers`);

    const promises = providers.map(async (i, el) => {
      const $provider = $(el);
      const encodedUrl = $provider.attr('data-player');
      const providerName = $provider.text().trim();
      
      if (!encodedUrl) {
        return null;
      }
      
      try {
        const decodedUrl = Buffer.from(encodedUrl, 'base64').toString('utf8');
        if (!decodedUrl.startsWith('http')) {
          return null;
        }
        
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
        console.error(`❌ Error processing ${providerName}:`, err.message);
        return null;
      }
    }).get(); // .get() to convert Cheerio object to plain array

    const results = await Promise.all(promises);
    const streams = results.filter(stream => stream !== null);
    
    console.log(`🎬 Final result: Found ${streams.length} streams for episode ${id}`);
    return { streams };

  } catch (error) {
    console.error(`❌ Stream error for ${id}:`, error.message);
    return { streams: [] };
  }
});

module.exports = builder.getInterface();
