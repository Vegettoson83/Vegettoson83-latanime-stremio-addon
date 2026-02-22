/**
 * LATANIME STREMIO ADDON — v3.1
 * Cloudflare Worker + Render Bridge (Playwright)
 */

interface Env {
  TMDB_KEY?:    string;
  BRIDGE_URL?:  string;  // https://latanime-bridge.onrender.com
}

const ADDON_ID = "com.latanime.stremio";
const BASE_URL  = "https://latanime.org";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG  = "https://image.tmdb.org/t/p/w500";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

const CACHE = new Map<string, { data: unknown; expires: number }>();
function cacheGet(key: string): unknown | null {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { CACHE.delete(key); return null; }
  return e.data;
}
function cacheSet(key: string, data: unknown, ttlMs: number) {
  CACHE.set(key, { data, expires: Date.now() + ttlMs });
}
const TTL = { catalog: 10 * 60 * 1000, meta: 2 * 60 * 60 * 1000, stream: 30 * 60 * 1000 };

const MANIFEST = {
  id: ADDON_ID,
  version: "3.2.0",
  name: "Latanime",
  description: "Anime Latino y Castellano desde latanime.org",
  logo: "https://latanime.org/public/img/logito.png",
  resources: ["catalog", "meta", "stream"],
  types: ["series"],
  catalogs: [
    { type: "series", id: "latanime-latest",   name: "Latanime — Recientes",  extra: [{ name: "search", isRequired: false }] },
    { type: "series", id: "latanime-airing",   name: "Latanime — En Emisión", extra: [] },
    { type: "series", id: "latanime-directory", name: "Latanime — Directorio", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
  ],
  idPrefixes: ["latanime:"],
};

async function fetchHtml(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      "Referer": BASE_URL,
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

async function fetchTmdb(animeName: string, tmdbKey: string): Promise<{ poster: string; background: string; description: string; year: string } | null> {
  if (!tmdbKey) return null;
  const cleanName = animeName.replace(/\s+(Latino|Castellano|Japones|Japonés|Sub\s+Español)$/i, "").replace(/\s+S(\d+)$/i, " Season $1").trim();
  try {
    const r = await fetch(`${TMDB_BASE}/search/tv?api_key=${tmdbKey}&query=${encodeURIComponent(cleanName)}&language=es-ES`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const data = await r.json() as { results?: Record<string, unknown>[] };
    const hit = data.results?.[0];
    if (!hit) return null;
    return {
      poster:      hit.poster_path   ? `${TMDB_IMG}${hit.poster_path}` : "",
      background:  hit.backdrop_path ? `https://image.tmdb.org/t/p/w1280${hit.backdrop_path}` : "",
      description: (hit.overview as string) || "",
      year:        ((hit.first_air_date as string) || "").slice(0, 4),
    };
  } catch { return null; }
}

function parseAnimeCards(html: string): { id: string; name: string; poster: string }[] {
  const results: { id: string; name: string; poster: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href=["'](?:https?:\/\/latanime\.org)?\/anime\/([a-z0-9][a-z0-9-]+)["']/gi)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const pos   = m.index! + m[0].length;
    const block = html.slice(pos, pos + 600);
    const titleM = block.match(/<h3[^>]*>([^<]{3,})<\/h3>/i) || block.match(/alt="([^"]{3,})"/) || block.match(/title="([^"]{3,})"/);
    const name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : slug;
    if (!name || name.length < 2) continue;
    const posterM =
      block.match(/data-src="(https?:\/\/latanime\.org\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      block.match(/data-src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      block.match(/src="(https?:\/\/latanime\.org\/(?:thumbs|assets)\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/);
    const poster = posterM ? (posterM[1].startsWith("http") ? posterM[1] : `${BASE_URL}${posterM[1]}`) : "";
    results.push({ id: `latanime:${slug}`, name, poster });
  }
  return results.slice(0, 100);
}

function toMetaPreview(c: { id: string; name: string; poster: string }) {
  return { id: c.id, type: "series", name: c.name, poster: c.poster || `${BASE_URL}/public/img/anime.png`, posterShape: "poster" };
}

async function searchAnimes(query: string): Promise<{ id: string; name: string; poster: string }[]> {
  const homeHtml = await fetchHtml(`${BASE_URL}/`);
  const csrfM = homeHtml.match(/name="csrf-token"[^>]+content="([^"]+)"/i) || homeHtml.match(/content="([^"]+)"[^>]+name="csrf-token"/i);
  const csrf = csrfM ? csrfM[1] : "";
  try {
    const r = await fetch(`${BASE_URL}/buscar_ajax`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrf, "X-Requested-With": "XMLHttpRequest", "Referer": `${BASE_URL}/`, "Origin": BASE_URL, "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify({ q: query }),
    });
    if (r.ok) { const html = await r.text(); const results = parseAnimeCards(html); if (results.length > 0) return results; }
  } catch { /* fall through */ }
  return parseAnimeCards(await fetchHtml(`${BASE_URL}/buscar?q=${encodeURIComponent(query)}`));
}

async function getCatalog(catalogId: string, extra: Record<string, string>) {
  if (extra.search?.trim()) return { metas: (await searchAnimes(extra.search.trim())).map(toMetaPreview) };
  if (catalogId === "latanime-airing") return { metas: parseAnimeCards(await fetchHtml(`${BASE_URL}/emision`)).map(toMetaPreview) };
  if (catalogId === "latanime-directory") {
    const page = Math.floor(parseInt(extra.skip || "0", 10) / 30) + 1;
    return { metas: parseAnimeCards(await fetchHtml(`${BASE_URL}/animes?page=${page}`)).map(toMetaPreview) };
  }
  return { metas: parseAnimeCards(await fetchHtml(`${BASE_URL}/`)).map(toMetaPreview) };
}

async function getMeta(id: string, tmdbKey: string) {
  const slug = id.replace("latanime:", "");
  const html = await fetchHtml(`${BASE_URL}/anime/${slug}`);
  const titleM = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || html.match(/<title>(.*?)\s*[—\-|].*?<\/title>/i);
  const name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : slug;
  const posterM = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
  const poster = posterM ? posterM[1] : "";
  const descM = html.match(/<p[^>]*class="[^"]*opacity[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
  const description = descM ? descM[1].replace(/<[^>]+>/g, "").trim() : "";
  const genres: string[] = [];
  for (const gm of html.matchAll(/href="[^"]*\/genero\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const g = gm[1].replace(/<[^>]+>/g, "").trim();
    if (g) genres.push(g);
  }
  const episodes: { id: string; number: number }[] = [];
  const seenEps = new Set<string>();
  for (const em of html.matchAll(/href=["'](?:https?:\/\/latanime\.org)?\/ver\/([a-z0-9-]+-episodio-(\d+(?:\.\d+)?))["']/gi)) {
    if (seenEps.has(em[1])) continue;
    seenEps.add(em[1]);
    episodes.push({ id: `latanime:${slug}:${parseFloat(em[2])}`, number: parseFloat(em[2]) });
  }
  episodes.sort((a, b) => a.number - b.number);
  const tmdb = await fetchTmdb(name, tmdbKey);
  return {
    meta: {
      id, type: "series", name,
      poster: tmdb?.poster || poster,
      background: tmdb?.background || poster,
      description: tmdb?.description || description,
      posterShape: "poster",
      releaseInfo: tmdb?.year || "",
      genres: genres.slice(0, 10),
      videos: episodes.map((ep) => ({ id: ep.id, title: `Episodio ${ep.number}`, season: 1, episode: ep.number, released: new Date(0).toISOString() })),
    },
  };
}

// ─── DIRECT EXTRACTORS (no browser needed) ───────────────────────────────────

// mp4upload: file URL is in the HTML
async function extractMp4upload(embedUrl: string): Promise<string | null> {
  try {
    const html = await fetchHtml(embedUrl);
    const m =
      html.match(/"file"\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/) ||
      html.match(/src:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/) ||
      html.match(/file:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

// filemoon: unpack eval(function(p,a,c,k,e,d)) to get m3u8
async function extractFilemoon(embedUrl: string): Promise<string | null> {
  try {
    const r = await fetch(embedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Referer": "https://latanime.org/",
      }
    });
    const html = await r.text();

    // Find packed JS block: eval(function(p,a,c,k,e,d){...}('packed',base,count,'dict'))
    const m = html.match(/eval\(function\(p,a,c,k,e,(?:d|r)\)\{.+?\}\('([\s\S]+?)',(\d+),(\d+),'([\s\S]+?)'\.split\('\|'\)\)\)/);
    if (!m) return null;

    const packed = m[1];
    const base = parseInt(m[2]);
    const dict = m[4].split("|");

    // Unpack: replace each base-N token with dict lookup
    const unpacked = packed.replace(/\w+/g, (word) => {
      const n = parseInt(word, base);
      return (n < dict.length && dict[n]) ? dict[n] : word;
    });

    // Extract m3u8 URL from unpacked string
    const url = unpacked.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
    return url ? url[0] : null;
  } catch { return null; }
}

// voe.sx: var source = 'URL' is in the HTML — or decoded from JSON blob
async function extractVoe(embedUrl: string): Promise<string | null> {
  try {
    const html = await fetch(embedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Referer": "https://latanime.org/",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      }
    }).then(r => r.text());

    // Primary: var source = '...' in plain HTML
    const srcM =
      html.match(/var\s+source\s*=\s*'(https?:\/\/[^']+\.(?:mp4|m3u8)[^']*)'/) ||
      html.match(/var\s+source\s*=\s*"(https?:\/\/[^"]+\.(?:mp4|m3u8)[^"]*)"/) ||
      html.match(/"file"\s*:\s*"(https?:\/\/[^"]+\.(?:mp4|m3u8)[^"]*)"/) ||
      html.match(/sources\s*:\s*\[\s*\{\s*[^}]*file\s*:\s*'(https?:\/\/[^']+\.(?:mp4|m3u8)[^']*)'/);

    if (srcM && !srcM[1].includes("test-videos") && !srcM[1].includes("bigbuck")) {
      return srcM[1];
    }

    // Secondary: look for hls source or mp4 in script JSON
    const hlsM = html.match(/"hls"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/) ||
                 html.match(/hls_url\s*[:=]\s*["'`](https?:\/\/[^"'`]+)["'`]/);
    if (hlsM) return hlsM[1];

    return null;
  } catch { return null; }
}

// hexload: POST to /download with op=download3 returns mp4 URL
async function extractHexload(embedUrl: string): Promise<string | null> {
  try {
    // Extract file ID from embed URL: /embed-k5el8mvrft9y -> k5el8mvrft9y
    const fileId = embedUrl.split("embed-").pop()?.split(/[/?]/)[0];
    if (!fileId) return null;

    // First fetch the embed page to get cookies/session
    const embedR = await fetch(embedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Referer": "https://latanime.org/",
      }
    });
    const cookies = embedR.headers.get("set-cookie") || "";

    // POST to /download to get the actual mp4 URL
    const r = await fetch("https://hexload.com/download", {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Referer": embedUrl,
        "Origin": "https://hexload.com",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "Cookie": cookies,
      },
      body: new URLSearchParams({
        op: "download3",
        id: fileId,
        ajax: "1",
        method_free: "1",
      }).toString(),
    });
    const data = await r.json() as { msg?: string; result?: { url?: string } };
    if (data.msg === "OK" && data.result?.url) return data.result.url;
    return null;
  } catch { return null; }
}

// latanime /reproductor proxy: they proxy every embed through their own server
async function extractViaReproductor(embedUrl: string): Promise<string | null> {
  try {
    const b64 = btoa(embedUrl);
    const reproUrl = `${BASE_URL}/reproductor?url=${b64}`;
    const html = await fetch(reproUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Referer": BASE_URL,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }).then(r => r.text());
    const m =
      html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/) ||
      html.match(/"file"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/) ||
      html.match(/["'](https?:\/\/[^"']+\.mp4[^"']{0,50})["']/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Direct host extractors — send correct Referer per host to bypass hotlink protection
async function extractDirect(embedUrl: string): Promise<string | null> {
  try {
    const origin = new URL(embedUrl).origin;
    const html = await fetch(embedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Referer": origin + "/",           // send host's OWN domain as referer
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9",
        "X-Requested-With": "XMLHttpRequest",
      },
    }).then(r => r.text());

    const m =
      html.match(/["'`](https?:\/\/[^"'`\s]{10,}\.m3u8[^"'`\s]*)["'`]/) ||
      html.match(/"file"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/) ||
      html.match(/hls[Uu]rl\s*[=:]\s*["'`](https?:\/\/[^"'`]+)["'`]/) ||
      html.match(/source\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/);
    return m ? m[1] : null;
  } catch { return null; }
}

// savefiles.com / streamhls.to — direct HLS extraction
// Flow: savefiles.com/{code} → streamhls.to/e/{code} → scrape master.m3u8
async function extractSavefiles(embedUrl: string): Promise<string | null> {
  try {
    // Normalize to streamhls embed URL
    // Possible inputs:
    //   https://savefiles.com/hxhufbkiftyf
    //   https://streamhls.to/e/hxhufbkiftyf
    let fileCode: string | null = null;

    const sfMatch = embedUrl.match(/savefiles\.com\/([a-z0-9]+)/i);
    const shMatch = embedUrl.match(/streamhls\.to\/e\/([a-z0-9]+)/i);
    if (sfMatch) fileCode = sfMatch[1];
    else if (shMatch) fileCode = shMatch[1];
    if (!fileCode) return null;

    const embedPageUrl = `https://streamhls.to/e/${fileCode}`;
    const html = await fetch(embedPageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Referer": "https://savefiles.com/",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      },
    }).then(r => r.text());

    // Look for HLS m3u8 in page source
    const m =
      html.match(/["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)["'`]/) ||
      html.match(/"file"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/) ||
      html.match(/source\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/);
    return m ? m[1] : null;
  } catch { return null; }
}

// ─── BRIDGE EXTRACTION ────────────────────────────────────────────────────────
async function extractViaBridge(embedUrl: string, bridgeUrl: string): Promise<string | null> {
  try {
    const r = await fetch(`${bridgeUrl}/extract?url=${encodeURIComponent(embedUrl)}`, {
      signal: AbortSignal.timeout(50000),
    });
    if (!r.ok) return null;
    const data = await r.json() as { url?: string };
    return data.url || null;
  } catch { return null; }
}

async function getStreams(rawId: string, env: Env, request?: Request) {
  const parts = rawId.replace("latanime:", "").split(":");
  if (parts.length < 2) return { streams: [] };
  const [slug, epNum] = parts;
  const html = await fetchHtml(`${BASE_URL}/ver/${slug}-episodio-${epNum}`);

  const embedUrls: { url: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a[^>]+data-player="([A-Za-z0-9+/=]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const b64 = m[1];
    const name = m[2].replace(/<[^>]+>/g, "").trim() || "Player";
    if (seen.has(b64)) continue;
    seen.add(b64);
    let embedUrl = "";
    try { embedUrl = atob(b64); } catch { continue; }
    if (embedUrl.startsWith("//")) embedUrl = `https:${embedUrl}`;
    if (!embedUrl.startsWith("http")) continue;
    embedUrls.push({ url: embedUrl, name });
  }

  if (embedUrls.length === 0) return { streams: [] };

  const bridgeUrl = (env.BRIDGE_URL || "").trim();
  const streams: { url: string; title: string; behaviorHints: { notWebReady: boolean } }[] = [];

  if (bridgeUrl) {
    // Parallel extraction — all at once, take whatever succeeds within 45s
    const results = await Promise.allSettled(
      embedUrls.map(async (embed) => {
        // voe.sx: var source is in plain HTML
        if (embed.url.includes("voe.sx") || embed.url.includes("lancewhosedifficult.com") || embed.url.includes("voeunblocked.")) {
          const streamUrl = await extractVoe(embed.url);
          return streamUrl ? { url: streamUrl, name: embed.name } : null;
        }
        // mp4upload: extract directly from HTML
        if (embed.url.includes("mp4upload.com")) {
          const streamUrl = await extractMp4upload(embed.url);
          return streamUrl ? { url: streamUrl, name: embed.name } : null;
        }
        // filemoon: unpack eval() to get m3u8
        if (embed.url.includes("filemoon.sx") || embed.url.includes("filemoon.to")) {
          const streamUrl = await extractFilemoon(embed.url);
          return streamUrl ? { url: streamUrl, name: embed.name } : null;
        }
        // hexload: POST API
        if (embed.url.includes("hexload.com")) {
          const streamUrl = await extractHexload(embed.url);
          return streamUrl ? { url: streamUrl, name: embed.name } : null;
        }
        // savefiles / streamhls: direct HLS from embed page
        if (embed.url.includes("savefiles.com") || embed.url.includes("streamhls.to")) {
          const streamUrl = await extractSavefiles(embed.url);
          return streamUrl ? { url: streamUrl, name: embed.name } : null;
        }
        // 1. Try direct extraction with correct Referer header
        const directUrl = await extractDirect(embed.url);
        if (directUrl) return { url: directUrl, name: embed.name };
        // 2. Try latanime /reproductor proxy
        const reproUrl = await extractViaReproductor(embed.url);
        if (reproUrl) return { url: reproUrl, name: embed.name };
        // 3. Fallback to Render bridge
        const streamUrl = await extractViaBridge(embed.url, bridgeUrl);
        return streamUrl ? { url: streamUrl, name: embed.name } : null;
      })
    );
    const extractedNames = new Set<string>();
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        const streamUrl = r.value.url;
        // Determine correct referrer based on stream CDN origin
        // For m3u8 streams: proxy through Worker to rewrite segment URLs
        // then Stremio fetches segments directly with proxyHeaders
        const isHls = streamUrl.includes(".m3u8");
        const workerBase = request ? new URL(request.url).origin : "";
        const finalUrl = isHls
          ? `${workerBase}/proxy/m3u8?url=${btoa(streamUrl)}&ref=${encodeURIComponent("https://latanime.org/")}`
          : streamUrl;

        streams.push({
          url: finalUrl,
          title: `▶ ${r.value.name} — Latino`,
          behaviorHints: {
            notWebReady: false,

          }
        });
        extractedNames.add(r.value.name);
      }
    }
    // Web fallback only for hosts that failed extraction
    for (const embed of embedUrls) {
      if (!extractedNames.has(embed.name)) {
        streams.push({ url: embed.url, title: `🌐 ${embed.name} — Latino`, behaviorHints: { notWebReady: true } });
      }
    }
  } else {
    // No bridge — all web fallback
    for (const embed of embedUrls) {
      streams.push({ url: embed.url, title: `🌐 ${embed.name} — Latino`, behaviorHints: { notWebReady: true } });
    }
  }

  return { streams };
}

// ─── ROUTER ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url  = new URL(request.url);
    const path = url.pathname;
    const tmdbKey  = (env.TMDB_KEY  || "").trim();
    const bridgeUrl = (env.BRIDGE_URL || "").trim();

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (path === "/" || path === "/manifest.json") return json(MANIFEST);

    // Debug
    if (path === "/debug") {
      return json({ tmdbKey: tmdbKey ? "set" : "not set", bridgeUrl: bridgeUrl || "not set" });
    }

    // Quick savefiles/streamhls test
    if (path === "/debug-savefiles") {
      const code = url.searchParams.get("code") || "hxhufbkiftyf";
      const testUrl = `https://savefiles.com/${code}`;
      const t0 = Date.now();
      const streamUrl = await extractSavefiles(testUrl);
      return json({ code, streamUrl, ms: Date.now() - t0 });
    }

    if (path === "/debug-bridge") {
      const testUrl = url.searchParams.get("url") || "https://luluvid.com/e/t66o00zj95a9";
      if (!bridgeUrl) return json({ error: "BRIDGE_URL not set" });
      const t0 = Date.now();
      try {
        const r = await fetch(`${bridgeUrl}/extract?url=${encodeURIComponent(testUrl)}`, {
          signal: AbortSignal.timeout(50000),
        });
        const body = await r.text();
        return json({ status: r.status, body, testUrl, bridgeUrl, ms: Date.now() - t0 });
      } catch(e: any) {
        return json({ error: String(e), testUrl, bridgeUrl, ms: Date.now() - t0 });
      }
    }

    const catM = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/);
    if (catM) {
      const [, , catalogId, extraStr] = catM;
      const extra: Record<string, string> = {};
      if (extraStr) extraStr.split("&").forEach((p) => { const [k, v] = p.split("="); if (k && v) extra[k] = decodeURIComponent(v); });
      if (url.searchParams.get("search")) extra.search = url.searchParams.get("search")!;
      const cacheKey = `catalog:${catalogId}:${extra.search || extra.skip || ""}`;
      const cached = cacheGet(cacheKey);
      if (cached) return json(cached);
      try { const result = await getCatalog(catalogId, extra); cacheSet(cacheKey, result, TTL.catalog); return json(result); }
      catch (e) { return json({ metas: [], error: String(e) }); }
    }

    const metaM = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
    if (metaM) {
      const id = decodeURIComponent(metaM[2]);
      const cached = cacheGet(`meta:${id}`);
      if (cached) return json(cached);
      try { const result = await getMeta(id, tmdbKey); cacheSet(`meta:${id}`, result, TTL.meta); return json(result); }
      catch (e) { return json({ meta: null, error: String(e) }); }
    }

    const streamM = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (streamM) {
      const id = decodeURIComponent(streamM[2]);
      const cached = cacheGet(`stream:${id}`);
      if (cached) return json(cached);
      try {
        const result = await getStreams(id, env, request);
        if ((result.streams as unknown[]).length > 0) cacheSet(`stream:${id}`, result, TTL.stream);
        return json(result);
      } catch (e) { return json({ streams: [], error: String(e) }); }
    }

    // Debug: fetch any embed URL from Worker's CF IP and return HTML + found URLs
    if (path === "/debug-host") {
      const embedUrl = url.searchParams.get("url");
      if (!embedUrl) return new Response("Missing url", { status: 400 });
      const hdrs = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Referer": "https://latanime.org/",
        "Origin": "https://latanime.org",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9",
      };
      try {
        const r = await fetch(embedUrl, { headers: hdrs });
        const html = await r.text();
        const urls = [...html.matchAll(/["'`](https?:\/\/[^"'`\s]{15,}\.(?:mp4|mkv|m3u8|ts)[^"'`\s]*)/gi)]
          .map(m => m[1]);

        // Extra: fetch /myjs.js for hexload
        let extra: Record<string, string> = {};
        if (embedUrl.includes("hexload.com")) {
          const jsR = await fetch("https://hexload.com/myjs.js?9", {
            headers: { ...hdrs, "Referer": embedUrl }
          });
          extra.myjs = (await jsR.text()).slice(0, 3000);
        }

        // Test filemoon unpacker inline
        if (embedUrl.includes("filemoon")) {
          const m = html.match(/eval\(function\(p,a,c,k,e,(?:d|r)\)\{.+?\}\('([\s\S]+?)',(\d+),(\d+),'([\s\S]+?)'\.split\('\|'\)\)\)/);
          extra.packedFound = m ? "YES" : "NO";
          extra.packedSnippet = html.includes("eval(function") ? html.substring(html.indexOf("eval(function"), html.indexOf("eval(function") + 200) : "eval(function NOT FOUND";
        }

        return Response.json({
          status: r.status,
          contentType: r.headers.get("content-type"),
          htmlLen: html.length,
          foundUrls: urls,
          htmlSnippet: html.slice(0, 5000),
          extra,
        }, { headers: CORS });
      } catch(e) {
        return Response.json({ error: String(e) }, { headers: CORS });
      }
    }

    // Full transparent proxy — Worker fetches everything, pipes to Stremio
    if (path === "/proxy/m3u8") {
      const m3u8Url = url.searchParams.get("url");
      const referer = url.searchParams.get("ref") || "https://latanime.org/";
      if (!m3u8Url) return new Response("Missing url", { status: 400 });
      try {
        const decoded = atob(m3u8Url);
        const base = decoded.substring(0, decoded.lastIndexOf("/") + 1);
        const workerBase = new URL(request.url).origin;
        const r = await fetch(decoded, {
          headers: {
            "Referer": referer,
            "Origin": "https://latanime.org",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
          }
        });
        if (!r.ok) return new Response(`Upstream ${r.status}`, { status: r.status });
        const m3u8Text = await r.text();
        // Rewrite ALL segment/playlist URLs through our segment proxy
        const rewritten = m3u8Text.split("\n").map(line => {
          const trimmed = line.trim();
          if (trimmed.startsWith("#") || trimmed === "") return line;
          const absUrl = trimmed.startsWith("http") ? trimmed : base + trimmed;
          return `${workerBase}/proxy/seg?url=${btoa(absUrl)}&ref=${encodeURIComponent(referer)}`;
        }).join("\n");
        return new Response(rewritten, {
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
          }
        });
      } catch(e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // Segment proxy — pipes TS segments from CDN to Stremio
    if (path === "/proxy/seg") {
      const segUrl = url.searchParams.get("url");
      const referer = url.searchParams.get("ref") || "https://latanime.org/";
      if (!segUrl) return new Response("Missing url", { status: 400 });
      try {
        const decoded = atob(segUrl);
        const r = await fetch(decoded, {
          headers: {
            "Referer": referer,
            "Origin": "https://latanime.org",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
          }
        });
        if (!r.ok) return new Response(`Upstream ${r.status}`, { status: r.status });
        return new Response(r.body, {
          headers: {
            "Content-Type": r.headers.get("Content-Type") || "video/MP2T",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
          }
        });
      } catch(e) {
        return new Response(String(e), { status: 500 });
      }
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
