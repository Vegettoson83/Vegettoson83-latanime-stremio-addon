
const { addonBuilder } = require("stremio-addon-sdk");
const addonInterface = require("./addon.js");

async function test() {
    console.log("=== TESTING CATALOG ===");
    try {
        const catalogResp = await addonInterface.catalog({
            type: 'series',
            id: 'latanime-series',
            extra: {}
        });
        console.log(`Catalog returned ${catalogResp.metas.length} items`);
        if (catalogResp.metas.length > 0) {
            console.log("First item:", catalogResp.metas[0]);
        }
    } catch (e) {
        console.error("Catalog failed:", e);
    }

    console.log("\n=== TESTING META ===");
    // Use a known ID from inspection (e.g., hazbin-hotel-temporada-2)
    const testId = 'latanime-hazbin-hotel-temporada-2';
    try {
        const metaResp = await addonInterface.meta({
            type: 'series',
            id: testId
        });
        console.log("Meta Name:", metaResp.meta.name);
        console.log(`Videos count: ${metaResp.meta.videos ? metaResp.meta.videos.length : 0}`);
        if (metaResp.meta.videos && metaResp.meta.videos.length > 0) {
            console.log("First Video:", metaResp.meta.videos[0]);
        }
    } catch (e) {
        console.error("Meta failed:", e);
    }

    console.log("\n=== TESTING STREAM ===");
    // Use a known episode ID from inspection (e.g., hazbin-hotel-temporada-2-episodio-8)
    const streamId = 'latanime-hazbin-hotel-temporada-2-episodio-8';
    try {
        const streamResp = await addonInterface.stream({
            type: 'series',
            id: streamId
        });
        console.log(`Streams found: ${streamResp.streams.length}`);
        if (streamResp.streams.length > 0) {
            console.log("First Stream:", streamResp.streams[0]);
        }
    } catch (e) {
        console.error("Stream failed:", e);
    }
}

test();
