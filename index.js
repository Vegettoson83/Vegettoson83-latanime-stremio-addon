const { addonBuilder } = require("stremio-addon-sdk");
const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const axios = require("axios");

// --- 1. MANIFEST ---
const manifest = {
  id: "org.latanime.stremio",
  version: "1.1.0",
  name: "Latanime Dynamic",
  description: "Anime streaming from latanime.org with full catalog, meta, and stream support.",
  catalogs: [
    {
      type: "series",
      id: "latanime",
      name: "Latanime Anime",
      extra: [{ name: "search", isRequired: false }]
    }
  ],
  resources: ["catalog", "meta", "stream"],
  types: ["series"],
  idPrefixes: ["latanime_"]
};
const builder = new addonBuilder(manifest);

// --- 2. Shared Puppeteer Browser ---
let sharedBrowser = null;
async function getBrowser() {
  if (!sharedBrowser) {
    sharedBrowser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    });
  }
  return sharedBrowser;
}

// --- 3. Catalog Handler (dynamic + search) ---
builder.defineCatalogHandler(async ({ extra }) => {
  try {
    const searchQuery = extra?.search?.toLowerCase() || null;
    const res = await axios.get("https://latanime.org/");
    const $ = cheerio.load(res.data);
    const metas = [];

    $("a.item.capa").each((_, el) => {
      const url = $(el).attr("href");
      const slugMatch = url.match(/\/anime\/(.+?)\/$/);
      if (!slugMatch) return;

      const slug = slugMatch[1];
      const name = $(el).find(".text-center").text().trim();
      const poster = $(el).find("img").attr("data-src");

      if (!searchQuery || name.toLowerCase().includes(searchQuery)) {
        metas.push({
          id: `latanime_${slug}`,
          type: "series",
          name: name || slug.replace(/-/g, " "),
          poster,
          description: `Anime from Latanime.org`
        });
      }
    });

    return { metas: metas.slice(0, 50) }; // limit for performance
  } catch (err) {
    console.error("Catalog extraction failed:", err.message);
    return { metas: [] };
  }
});

// --- 4. Meta Handler (scrape episodes dynamically) ---
builder.defineMetaHandler(async ({ id }) => {
  const slug = id.replace("latanime_", "");
  const animeUrl = `https://latanime.org/anime/${slug}/`;

  try {
    const res = await axios.get(animeUrl);
    const $ = cheerio.load(res.data);
    const videos = [];

    $("ul.list_series li a").each((_, el) => {
      const epLink = $(el).attr("href");
      const epNumMatch = epLink.match(/episodio-(\d+)/);
      if (!epNumMatch) return;

      const epNum = parseInt(epNumMatch[1]);
      const title = $(el).text().trim() || `Episodio ${epNum}`;
      videos.push({
        id: `${id}_ep${epNum}`,
        title,
        episode: epNum,
        season: 1,
        released: new Date().toISOString()
      });
    });

    videos.reverse();
    const name = $(".header h1").text().trim() || slug.replace(/-/g, " ");
    const poster = $(".capa img").attr("data-src");
    const description = $("p.sinopsis").text().trim() || "Sinopsis no disponible.";

    return { meta: { id, type: "series", name, poster, description, videos } };
  } catch (err) {
    console.error(`Meta extraction failed for ${slug}:`, err.message);
    return { meta: { id, type: "series", name: slug.replace(/-/g, " "), videos: [] } };
  }
});

// --- 5. Stream Handler (dynamic Puppeteer extraction) ---
builder.defineStreamHandler(async ({ id }) => {
  const m = id.match(/latanime_(.+)_ep(\d+)/);
  if (!m) return { streams: [] };

  const [_, animeSlug, epNum] = m;
  const epUrl = `https://latanime.org/ver/${animeSlug}-episodio-${epNum}`;

  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.goto(epUrl, { waitUntil: "networkidle2", timeout: 30000 });

    const sources = await page.evaluate(() => {
      function decodeBase64(str) { try { return atob(str); } catch { return null; } }
      const streams = [];

      document.querySelectorAll("[data-player]").forEach(el => {
        const url = decodeBase64(el.getAttribute("data-player"));
        if (url && url.startsWith("http")) streams.push({ url, name: el.textContent.trim() || "embed" });
      });

      document.querySelectorAll("a, iframe").forEach(el => {
        const url = el.href || el.src;
        if (!url || streams.some(s => s.url === url)) return;
        if (/pixeldrain|mega|mediafire|gofile|cloud|filemoon|mp4upload|lulu|dsvplay|listeamed|voe|uqload|ok|bembed/.test(url))
          streams.push({ url, name: el.textContent.trim() || "direct" });
      });

      return streams;
    });

    await page.close();

    // Filter to known hosts (optional, safer)
    const allowedHosts = ["ok.ru","streamtape.com","vivo.sx","dood.yt","mixdrop.co","fembed.com"];
    const filtered = (sources || []).filter(s => allowedHosts.some(h => s.url.includes(h)));

    return { streams: filtered.map(s => ({ name: s.name, url: s.url })) };
  } catch (err) {
    console.error("Stream extraction failed:", err.message);
    return { streams: [] };
  }
});

// --- 6. Export ---
module.exports = builder.getInterface();
