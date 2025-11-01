const { addonBuilder } = require("stremio-addon-sdk");
const puppeteer = require("puppeteer");

// --- 1. MANIFEST ---
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

// --- 2. Shared Browser for Puppeteer ---
let sharedBrowser = null;
async function getBrowser() {
  if (!sharedBrowser) {
    sharedBrowser = await puppeteer.launch({
      headless: true,  // stable headless mode
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
  }
  return sharedBrowser;
}

// --- 3. Catalog Handler ---
builder.defineCatalogHandler(async () => {
  return { metas: [
      { id: "latanime_un-go-latino", type: "series", name: "Un-Go Latino" },
      { id: "latanime_hello-world", type: "series", name: "Hello World" }
  ]};
});

// --- 4. Meta Handler ---
builder.defineMetaHandler(async ({ id }) => {
  const slug = id.replace(/latanime_/, "");
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
  };
});

// --- 5. Stream Handler ---
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

    // Optional: filter only allowed hosts
    const allowedHosts = ["ok.ru","streamtape.com","vivo.sx","dood.yt","mixdrop.co","fembed.com"];
    const filtered = (sources || []).filter(s => allowedHosts.some(h => s.url.includes(h)));

    return { streams: filtered.map(s => ({ name: s.name, url: s.url })) };
  } catch (err) {
    console.error("Stream extraction failed:", err.message);
    return { streams: [] };
  }
});

// --- 6. Export for Stremio ---
module.exports = builder.getInterface();
