const { addonBuilder } = require("stremio-addon-sdk");
const https = require("https");
const cheerio = require("cheerio");

// Improved HTTPS GET with better error handling and timeout
function get(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(res.headers.location, timeout));
      } 
      
      // Handle non-success status codes
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || 'Request failed'}`));
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(body);
        } catch (error) {
          reject(new Error('Failed to parse response'));
        }
      });
      res.on('error', reject);
    });

    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
    
    request.on('error', reject);
  });
}

// Manifest with better configuration
const builder = new addonBuilder({
  id: "community.latanime",
  version: "0.0.2", // Bumped version
  name: "Latanime",
  description: "Stremio addon for latanime.org - Watch anime with Spanish subtitles",
  resources: ["catalog", "stream", "meta"],
  types: ["series"],
  catalogs: [
    { 
      type: "series", 
      id: "latanime-recent", 
      name: "Latanime - Recent",
      extra: [
        { name: "skip", isRequired: false }
      ]
    }
  ]
});

// Improved catalog handler with error handling
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log(`Catalog request: ${type}/${id}`);
  
  if (type !== "series" || id !== "latanime-recent") {
    return { metas: [] };
  }

  try {
    const html = await get("https://latanime.org/animes");
    const $ = cheerio.load(html);
    const metas = [];

    // More robust selector parsing
    $(".animes .col-6, .anime-grid .anime-item").each((i, el) => {
      try {
        const $el = $(el);
        const $link = $el.find("a").first();
        const $img = $link.find("img");
        
        const title = $link.attr("title") || $img.attr("alt") || $link.text().trim();
        const href = $link.attr("href");
        let poster = $img.attr("src") || $img.attr("data-src");
        
        if (title && href) {
          // Extract ID from href
          const idMatch = href.match(/\/anime\/([^\/]+)/);
          const id = idMatch ? idMatch[1] : href.split("/").pop();
          
          // Fix relative poster URLs
          if (poster && !poster.startsWith('http')) {
            poster = poster.startsWith('/') ? `https://latanime.org${poster}` : `https://latanime.org/${poster}`;
          }
          
          if (id && title.length > 0) {
            metas.push({
              id: id,
              type: "series",
              name: title,
              poster: poster || undefined,
              background: poster || undefined
            });
          }
        }
      } catch (itemError) {
        console.warn('Error parsing catalog item:', itemError.message);
      }
    });

    console.log(`Found ${metas.length} anime titles`);
    return { metas: metas.slice(0, 100) }; // Limit results
    
  } catch (error) {
    console.error('Catalog error:', error.message);
    return { metas: [] };
  }
});

// Improved meta handler
builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`Meta request: ${type}/${id}`);
  
  if (type !== "series") {
    return { meta: null };
  }

  try {
    const html = await get(`https://latanime.org/anime/${encodeURIComponent(id)}`);
    const $ = cheerio.load(html);

    // More flexible selectors
    const title = $(".titulo-anime, .anime-title, h1").first().text().trim() || id;
    const description = $(".sinopsis, .anime-description, .description").first().text().trim() || "No description available";
    let poster = $(".anime-single-left img, .anime-poster img, .poster img").first().attr("src");
    
    // Fix poster URL
    if (poster && !poster.startsWith('http')) {
      poster = poster.startsWith('/') ? `https://latanime.org${poster}` : `https://latanime.org/${poster}`;
    }

    // Extract genres
    const genres = [];
    $(".generos a, .genres a, .anime-genres a").each((i, el) => {
      const genre = $(el).text().trim();
      if (genre) genres.push(genre);
    });

    // Extract episodes with better error handling
    const videos = [];
    $(".episodes-list .col-6, .episode-list .episode, .episodes .episode-item").each((i, el) => {
      try {
        const $el = $(el);
        const $link = $el.find("a").first();
        const episodeTitle = $link.attr("title") || $link.text().trim();
        const href = $link.attr("href");
        
        if (episodeTitle && href) {
          // Extract episode ID and number
          const episodeId = href.split("/").pop();
          let episodeNumber = i + 1;
          
          // Try to extract episode number from title
          const numberMatch = episodeTitle.match(/(?:Capitulo|Episode|Ep\.?)\s*(\d+)/i);
          if (numberMatch) {
            episodeNumber = parseInt(numberMatch[1]);
          }
          
          videos.push({
            id: episodeId,
            title: episodeTitle,
            season: 1,
            episode: episodeNumber,
            released: new Date().toISOString()
          });
        }
      } catch (episodeError) {
        console.warn('Error parsing episode:', episodeError.message);
      }
    });

    const meta = {
      id,
      type: "series",
      name: title,
      description,
      genres: genres.length > 0 ? genres : undefined,
      poster: poster || undefined,
      background: poster || undefined,
      videos: videos.reverse() // Reverse to show latest episodes first
    };

    console.log(`Meta found: ${title} with ${videos.length} episodes`);
    return { meta };

  } catch (error) {
    console.error(`Meta error for ${id}:`, error.message);
    return { meta: null };
  }
});

// Improved stream handler
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`Stream request: ${type}/${id}`);
  
  if (type !== "series") {
    return { streams: [] };
  }

  try {
    const html = await get(`https://latanime.org/ver/${encodeURIComponent(id)}`);
    const $ = cheerio.load(html);
    const streams = [];

    // Look for video players with multiple selectors
    const playerSelectors = [
      ".cap_repro .play-video",
      ".video-players .player",
      ".players .player-option",
      "[data-player]"
    ];

    for (const selector of playerSelectors) {
      $(selector).each(async (i, el) => {
        try {
          const $el = $(el);
          const encodedUrl = $el.attr("data-player") || $el.attr("data-url");
          const playerName = $el.text().trim() || `Player ${i + 1}`;
          
          if (!encodedUrl) return;

          try {
            // Decode base64 URL
            const decodedUrl = Buffer.from(encodedUrl, "base64").toString("utf8");
            
            if (decodedUrl.startsWith('http')) {
              // Fetch the player page
              const playerHtml = await get(decodedUrl);
              const $player = cheerio.load(playerHtml);
              
              // Look for video sources with multiple selectors
              const videoSelectors = [
                "video source",
                "source[src]",
                "video[src]",
                "[data-src]"
              ];
              
              for (const videoSelector of videoSelectors) {
                $player(videoSelector).each((j, videoEl) => {
                  const videoUrl = $player(videoEl).attr("src") || $player(videoEl).attr("data-src");
                  if (videoUrl && videoUrl.startsWith('http')) {
                    streams.push({
                      url: videoUrl,
                      title: `${playerName} - Quality ${j + 1}`,
                      behaviorHints: {
                        bingeGroup: `latanime-${id.split('-')[0]}`
                      }
                    });
                  }
                });
              }
            }
          } catch (decodeError) {
            console.warn('Failed to decode player URL:', decodeError.message);
          }
        } catch (playerError) {
          console.warn('Error processing player:', playerError.message);
        }
      });
    }

    console.log(`Found ${streams.length} streams for ${id}`);
    return { streams: streams.slice(0, 10) }; // Limit streams

  } catch (error) {
    console.error(`Stream error for ${id}:`, error.message);
    return { streams: [] };
  }
});

module.exports = builder.getInterface();
