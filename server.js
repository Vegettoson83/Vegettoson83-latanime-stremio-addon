const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const manifest = require('./lib/manifest');
const scraper = require('./lib/scraper');

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async (args) => {
    console.log('Catalog request:', args.id, args.extra?.search);
    let metas = [];
    if (args.extra && args.extra.search) {
        metas = await scraper.searchAnime(args.extra.search);
    } else {
        metas = await scraper.getRecentAnime();
    }
    return { metas };
});

builder.defineMetaHandler(async (args) => {
    console.log('Meta request:', args.id);
    const slug = args.id.replace('latanime-', '');
    const meta = await scraper.getAnimeDetails(slug);
    return { meta };
});

builder.defineStreamHandler(async (args) => {
    console.log('Stream request:', args.id);
    const epSlug = args.id.replace('latanime-', '');
    const providers = await scraper.getEpisodeStreams(epSlug);

    const streams = [];

    // Attempt to extract direct URLs for the first few providers in parallel
    const extractPromises = providers.filter(p => !p.isDownload).slice(0, 3).map(async (provider) => {
        try {
            const directUrl = await scraper.extractDirectUrl(provider.url);
            if (directUrl) {
                return {
                    name: `Latanime - ${provider.name} (Direct)`,
                    title: provider.name,
                    url: directUrl,
                    behaviorHints: {
                        notWebReady: false
                    }
                };
            }
        } catch (e) {}
        return null;
    });

    const directStreams = (await Promise.all(extractPromises)).filter(s => s !== null);
    streams.push(...directStreams);

    // Always provide embed links as fallbacks
    for (const provider of providers) {
        if (provider.isDownload) continue;

        streams.push({
            name: `Latanime - ${provider.name} (Embed)`,
            title: provider.name,
            url: provider.url,
            externalUrl: provider.url // Good fallback if Stremio can't play it
        });
    }

    return { streams };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
