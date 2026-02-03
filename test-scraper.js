const scraper = require('./lib/scraper');

async function test() {
    console.log('Testing searchAnime...');
    const searchResults = await scraper.searchAnime('jujutsu kaisen');
    console.log('Search Results:', searchResults.slice(0, 2));

    console.log('\nTesting getRecentAnime...');
    const recentResults = await scraper.getRecentAnime();
    console.log('Recent Results:', recentResults.slice(0, 2));

    if (searchResults.length > 0) {
        const slug = searchResults[0].id.replace('latanime-', '');
        console.log(`\nTesting getAnimeDetails for ${slug}...`);
        const details = await scraper.getAnimeDetails(slug);
        console.log('Details:', { ...details, videos: details.videos.slice(0, 2) });

        if (details.videos.length > 0) {
            const epSlug = details.videos[0].id.replace('latanime-', '');
            console.log(`\nTesting getEpisodeStreams for ${epSlug}...`);
            const streams = await scraper.getEpisodeStreams(epSlug);
            console.log('Streams:', streams);

            if (streams.length > 0) {
                const embeds = streams.filter(s => !s.isDownload).slice(0, 3);
                for (const embed of embeds) {
                    console.log(`\nTesting extractDirectUrl for ${embed.name} (${embed.url})...`);
                    const direct = await scraper.extractDirectUrl(embed.url);
                    console.log(`Direct URL for ${embed.name}:`, direct);
                    if (direct) break;
                }
            }
        }
    }
}

test();
