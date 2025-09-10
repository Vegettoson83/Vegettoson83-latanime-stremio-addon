const { addonBuilder } = require("stremio-addon-sdk");
const https = require("https");
const cheerio = require("cheerio");

// Simple HTTPS GET function
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
  version: "0.0.4",
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

// Enhanced catalog handler with multiple selectors
builder.defineCatalogHandler(async ({ type, id }) => {
  console.log(`📚 Catalog request: ${type}/${id}`);
  
  if (type !== "series" || id !== "latanime-top") {
    return { metas: [] };
  }

  try {
    console.log('🔍 Fetching latanime.org...');
    const html = await get("https://latanime.org/animes");
    const $ = cheerio.load(html);
    const metas = [];

    console.log('📄 Page loaded, parsing anime cards...');

    // Multiple possible selectors for anime cards
    const selectors = [
      '.animes .col-6',           // Original selector
      '.anime-card',              // Common card class
      '.card',                    // Generic card
      'article',                  // Article elements
      '.anime-item',              // Anime item
      '.grid-item',               // Grid item
      '[href*="/anime/"]',        // Any link to anime
      'a[title]'                  // Any link with title
    ];

    let foundItems = false;

    for (const selector of selectors) {
      console.log(`🔍 Trying selector: ${selector}`);
      const elements = $(selector);
      console.log(`📊 Found ${elements.length} elements with selector: ${selector}`);
      
      if (elements.length > 0) {
        elements.each((i, el) => {
          try {
            const $el = $(el);
            
            // Try to extract anime info in different ways
            let title, href, poster;
            
            // Method 1: Direct link with title
            if ($el.is('a')) {
              title = $el.attr('title') || $el.text().trim();
              href = $el.attr('href');
              poster = $el.find('img').attr('src') || $el.find('img').attr('data-src');
            }
            // Method 2: Find link inside element
            else {
              const $link = $el.find('a').first();
              title = $link.attr('title') || $link.text().trim();
              href = $link.attr('href');
              poster = $el.find('img').attr('src') || $el.find('img').attr('data-src');
            }
            
            // Clean up title and validate data
            if (title) {
              title = title.replace(/\s+/g, ' ').trim();
            }
            
            // Skip if we don't have essential data
            if (!title || !href || title.length < 2) {
              return;
            }
            
            // Skip navigation links, menus, etc.
            if (title.match(/^(Inicio|Menu|Login|Registro|Directorio|Emisión|Calendario)$/i)) {
              return;
            }
            
            // Extract anime ID from href
            let animeId;
            if (href.includes('/anime/')) {
              animeId = href.split('/anime/')[1]?.split('/')[0];
            } else {
              animeId = href.split('/').filter(p => p).pop();
            }
            
            if (!animeId) {
              return;
            }
            
            // Fix poster URL
            if (poster && !poster.startsWith('http')) {
              poster = poster.startsWith('/') ? `https://latanime.org${poster}` : `https://latanime.org/${poster}`;
            }
            
            // Skip duplicates
            if (metas.find(m => m.id === animeId || m.name === title)) {
              return;
            }
            
            metas.push({
              id: animeId,
              type: "series",
              name: title,
              poster: poster || undefined,
              background: poster || undefined
            });
            
            console.log(`✅ Added: ${title} (ID: ${animeId})`);
            foundItems = true;
            
          } catch (itemError) {
            console.warn('⚠️  Error parsing item:', itemError.message);
          }
        });
        
        // If we found items with this selector, use them
        if (foundItems) {
          console.log(`✅ Successfully used selector: ${selector}`);
          break;
        }
      }
    }

    // If no items found, try a more aggressive approach
    if (metas.length === 0) {
      console.log('🔍 No items found, trying aggressive search...');
      
      // Look for any links that might be anime
      $('a[href*="anime"]').each((i, el) => {
        if (metas.length >= 20) return false; // Limit results
        
        const $link = $(el);
        const title = $link.attr('title') || $link.text().trim();
        const href = $link.attr('href');
        
        if (title && href && title.length > 2 && !title.match(/^(Inicio|Menu|Login)$/i)) {
          const animeId = href.split('/').filter(p => p).pop();
          if (animeId && !metas.find(m => m.id === animeId)) {
            metas.push({
              id: animeId,
              type: "series",
              name: title,
              poster: undefined
            });
          }
        }
      });
    }

    console.log(`📚 Final result: Found ${metas.length} anime titles`);
    
    // Debug: Log some examples
    if (metas.length > 0) {
      console.log('📝 Sample titles:', metas.slice(0, 3).map(m => m.name));
    }
    
    return { metas: metas.slice(0, 50) };
    
  } catch (error) {
    console.error('❌ Catalog error:', error.message);
    console.error('❌ Stack:', error.stack);
    return { metas: [] };
  }
});

// Enhanced meta handler
builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`📄 Meta request: ${type}/${id}`);
  
  if (type !== "series") {
    return { meta: null };
  }

  try {
    const html = await get(`https://latanime.org/anime/${encodeURIComponent(id)}`);
    const $ = cheerio.load(html);

    // Try multiple selectors for title
    const titleSelectors = [
      '.titulo-anime',
      '.anime-title', 
      'h1',
      '.title',
      '.anime-name'
    ];
    
    let title = id;
    for (const selector of titleSelectors) {
      const found = $(selector).first().text().trim();
      if (found) {
        title = found;
        break;
      }
    }

    // Try multiple selectors for description
    const descSelectors = [
      '.sinopsis',
      '.synopsis',
      '.description',
      '.anime-description',
      '.summary'
    ];
    
    let description = "No description available";
    for (const selector of descSelectors) {
      const found = $(selector).first().text().trim();
      if (found && found.length > 20) {
        description = found;
        break;
      }
    }

    // Try multiple selectors for poster
    const posterSelectors = [
      '.anime-single-left img',
      '.anime-poster img',
      '.poster img',
      '.cover img',
      'img[src*="poster"]',
      'img[src*="cover"]'
    ];
    
    let poster;
    for (const selector of posterSelectors) {
      const found = $(selector).first().attr('src') || $(selector).first().attr('data-src');
      if (found) {
        poster = found.startsWith('http') ? found : `https://latanime.org${found}`;
        break;
      }
    }

    // Extract genres
    const genres = [];
    const genreSelectors = [
      '.generos a',
      '.genres a', 
      '.anime-genres a',
      '.tags a',
      '.categories a'
    ];
    
    for (const selector of genreSelectors) {
      $(selector).each((i, el) => {
        const genre = $(el).text().trim();
        if (genre && !genres.includes(genre)) {
          genres.push(genre);
        }
      });
      if (genres.length > 0) break;
    }

    // Extract episodes
    const videos = [];
    const episodeSelectors = [
      '.episodes-list .col-6',
      '.episode-list .episode',
      '.episodes .episode-item',
      '.episode-grid .episode',
      'a[href*="/ver/"]'
    ];
    
    for (const selector of episodeSelectors) {
      $(selector).each((i, el) => {
        try {
          const $el = $(el);
          const $link = $el.is('a') ? $el : $el.find('a').first();
          const episodeTitle = $link.attr('title') || $link.text().trim();
          const href = $link.attr('href');
          
          if (episodeTitle && href) {
            const episodeId = href.split('/').pop();
            let episodeNumber = i + 1;
            
            // Try to extract episode number
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
          console.warn('⚠️  Episode parse error:', episodeError.message);
        }
      });
      
      if (videos.length > 0) break;
    }

    const meta = {
      id,
      type: "series",
      name: title,
      description,
      genres: genres.length > 0 ? genres : undefined,
      poster: poster || undefined,
      background: poster || undefined,
      videos: videos.reverse()
    };

    console.log(`📄 Meta found: ${title} with ${videos.length} episodes`);
    return { meta };

  } catch (error) {
    console.error(`❌ Meta error for ${id}:`, error.message);
    return { meta: null };
  }
});

// Enhanced stream handler with correct selectors
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`🎬 Stream request: ${type}/${id}`);
  
  if (type !== "series") {
    return { streams: [] };
  }

  try {
    const html = await get(`https://latanime.org/ver/${encodeURIComponent(id)}`);
    const $ = cheerio.load(html);
    const streams = [];

    console.log('🔍 Looking for video providers...');

    // Use the correct selectors from the site structure
    const providers = $('ul.cap_repro li#play-video > a.play-video');
    console.log(`📺 Found ${providers.length} video providers`);

    if (providers.length === 0) {
      // Fallback selectors in case structure changes
      const fallbackSelectors = [
        '.cap_repro .play-video',
        '.video-players .player',
        '[data-player]',
        '.server-item'
      ];
      
      for (const selector of fallbackSelectors) {
        const fallbackProviders = $(selector);
        if (fallbackProviders.length > 0) {
          console.log(`📺 Found ${fallbackProviders.length} providers with fallback selector: ${selector}`);
          providers = fallbackProviders;
          break;
        }
      }
    }

    const promises = [];
    
    providers.each((i, el) => {
      const $provider = $(el);
      const encodedUrl = $provider.attr('data-player');
      const providerName = $provider.text().trim() || `Server ${i + 1}`;
      
      console.log(`🔍 Processing provider: ${providerName}`);
      
      if (!encodedUrl) {
        console.warn(`⚠️  No data-player found for provider: ${providerName}`);
        return;
      }
      
      const promise = (async () => {
        try {
          console.log(`🔓 Decoding URL for ${providerName}...`);
          const decodedUrl = Buffer.from(encodedUrl, 'base64').toString('utf8');
          console.log(`🔗 Decoded URL: ${decodedUrl.substring(0, 50)}...`);
          
          if (!decodedUrl.startsWith('http')) {
            console.warn(`⚠️  Invalid decoded URL for ${providerName}: ${decodedUrl}`);
            return;
          }
          
          console.log(`📡 Fetching player page for ${providerName}...`);
          const playerHtml = await get(decodedUrl);
          const $player = cheerio.load(playerHtml);
          
          // Look for video sources with multiple approaches
          const videoSelectors = [
            'video source[src]',     // Standard HTML5 video source
            'source[src]',           // Generic source tag
            'video[src]',            // Direct video src
            '[data-src*=".mp4"]',    // Data-src with mp4
            '[data-src*=".m3u8"]',   // Data-src with m3u8
            'iframe[src]'            // Embedded iframe
          ];
          
          let foundVideo = false;
          
          for (const videoSelector of videoSelectors) {
            $player(videoSelector).each((j, videoEl) => {
              const $video = $player(videoEl);
              let videoUrl = $video.attr('src') || $video.attr('data-src');
              
              if (videoUrl) {
                // Handle relative URLs
                if (!videoUrl.startsWith('http')) {
                  if (videoUrl.startsWith('/')) {
                    const baseUrl = new URL(decodedUrl).origin;
                    videoUrl = baseUrl + videoUrl;
                  } else {
                    const baseUrl = decodedUrl.split('/').slice(0, -1).join('/');
                    videoUrl = baseUrl + '/' + videoUrl;
                  }
                }
                
                // Validate video URL
                if (videoUrl.startsWith('http') && (
                  videoUrl.includes('.mp4') || 
                  videoUrl.includes('.m3u8') || 
                  videoUrl.includes('video') ||
                  videoUrl.includes('stream')
                )) {
                  const qualityInfo = $video.attr('data-quality') || 
                                    $video.attr('label') || 
                                    (videoUrl.includes('720') ? '720p' : 
                                     videoUrl.includes('480') ? '480p' : 
                                     videoUrl.includes('1080') ? '1080p' : 'Auto');
                  
                  streams.push({
                    url: videoUrl,
                    title: `${providerName} - ${qualityInfo}`,
                    behaviorHints: {
                      bingeGroup: `latanime-${id.split('-')[0]}`,
                      countryWhitelist: ['MX', 'ES', 'AR', 'CO', 'PE', 'VE', 'CL', 'EC', 'UY', 'PY', 'BO']
                    }
                  });
                  
                  console.log(`✅ Found stream: ${providerName} - ${qualityInfo}`);
                  foundVideo = true;
                }
              }
            });
            
            if (foundVideo) break;
          }
          
          if (!foundVideo) {
            console.warn(`⚠️  No video sources found for ${providerName}`);
          }
          
        } catch (err) {
          console.error(`❌ Error processing ${providerName}:`, err.message);
        }
      })();
      
      promises.push(promise);
    });

    // Wait for all providers to be processed
    await Promise.all(promises);
    
    console.log(`🎬 Final result: Found ${streams.length} streams for episode ${id}`);
    
    // Log stream details for debugging
    if (streams.length > 0) {
      console.log('📋 Available streams:');
      streams.forEach((stream, i) => {
        console.log(`  ${i + 1}. ${stream.title} - ${stream.url.substring(0, 50)}...`);
      });
    } else {
      console.warn('⚠️  No streams found - this might indicate a parsing issue');
    }
    
    return { streams: streams.slice(0, 10) }; // Limit to 10 streams max

  } catch (error) {
    console.error(`❌ Stream error for ${id}:`, error.message);
    console.error('❌ Stack trace:', error.stack);
    return { streams: [] };
  }
});

// Export the interface
const addonInterface = builder.getInterface();

console.log("🔧 AddonInterface created successfully");
console.log("🔧 Manifest ID:", addonInterface.manifest.id);

module.exports = addonInterface;
