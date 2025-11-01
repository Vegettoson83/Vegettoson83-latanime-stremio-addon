const { addonBuilder } = require("stremio-addon-sdk");
const puppeteer = require("puppeteer");

// Will use puppeteer for dynamic stream extraction
const manifest = {
  id: "org.latanime.stremio",
  version: "1.0.0",
  name: "Latanime Enhanced",
  description: "Anime streaming (dynamic extraction) from latanime.org.",
  catalogs: [{ type: "series", id: "latanime" }],
  resources: ["catalog", "meta", "stream"],
  types: ["series"],
  idPrefixes: ["latanime_"]
};
const builder = new addonBuilder(manifest);

// Catalog Handler — basic static HTML parsing (adjust selectors as needed)
builder.defineCatalogHandler(async () => {
  return { metas: [
      { id: "latanime_un-go-latino", type: "series", name: "Un-Go Latino" },
      { id: "latanime_hello-world", type: "series", name: "Hello World" }
  ]};
});

// Meta Handler — stubbed for demonstration (suggest course: scrape /anime/[slug] and parse episodes)
builder.defineMetaHandler(async ({ id }) => {
  const slug = id.replace(/latanime_/, "");
  // Episodes are mapped 1, 2, ..., up to N (could scrape this in production)
  return {
    meta: {
      id,
      type: "series",
      name: slug.replace(/-/g, " "),
      poster: "",
      description: `Dynamic extraction for ${slug}`,
      videos: Array.from({ length: 3 }).map((_, i) => ({
        id: `${id}_ep${i + 1}`,
        title: `Episodio ${i + 1}`
      }))
    }
  }
});

// Stream Handler — plug in dynamic enhanced logic
builder.defineStreamHandler(async ({ id }) => {
  // Parse anime and episode number
  const m = id.match(/latanime_(.+)_ep(\d+)/);
  if (!m) return [];

  const animeSlug = m[1];
  const epNum = m[2];
  const epUrl = `https://latanime.org/ver/${animeSlug}-episodio-${epNum}`;

  // Use puppeteer to dynamically extract sources per your enhanced logic
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  await page.goto(epUrl, { waitUntil: "networkidle2" });

  // Wait and extract sources: base64 player, iframe, download links
  const sources = await page.evaluate(() => {
    // --- BEGIN logic ported and condensed from your enhanced_stremio_scraper.js ---
    function decodeBase64(str) {
      try { return atob(str); } catch (e) { return null; }
    }
    let streams = [];
    document.querySelectorAll("[data-player]").forEach(el => {
      const src = decodeBase64(el.getAttribute("data-player"));
      if (src) streams.push({ url: src, name: el.textContent.trim() || "embed" });
    });
    document.querySelectorAll("a").forEach(el => {
      const href = el.href;
      if (/(pixeldrain|mega|mediafire|gofile|cloud|filemoon|mp4upload|lulu|dsvplay|listeamed|voe|uqload|ok|bembed)/.test(href))
        streams.push({ url: href, name: el.textContent.trim() || "direct" });
    });
    document.querySelectorAll("iframe").forEach(el => {
      const src = el.src;
      if (src && !streams.some(s => s.url === src))
        streams.push({ url: src, name: "iframe" });
    });
    return streams;
    // --- END logic ported ---
  });
  await browser.close();

  // Map to Stremio stream format
  return (sources || []).map(s => ({
    name: s.name,
    url: s.url
  }));
});

// Export for Stremio
module.exports = builder.getInterface();
