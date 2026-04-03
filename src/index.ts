import type { BrowserWorker } from "@cloudflare/puppeteer";

const ADDON_ID = "com.latanime.stremio";
const BASE_URL = "https://latanime.org";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json",
};

interface Env {
  MYBROWSER: Fetcher;
  STREAM_CACHE: KVNamespace;
  TMDB_KEY: string;
  BRIDGE_URL: string;
  MFP_URL: string;
  MFP_PASSWORD: string;
  SAVEFILES_KEY: string;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

const CACHE = new Map<string, { data: unknown; expires: number }>();
function cacheGet(key: string) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { CACHE.delete(key); return null; }
  return e.data;
}
function cacheSet(key: string, data: unknown, ttlMs: number) {
  CACHE.set(key, { data, expires: Date.now() + ttlMs });
}

const TTL = {
  catalog: 10 * 60 * 1000,
  meta: 2 * 60 * 60 * 1000,
  stream: 30 * 60 * 1000,
  browserStream: 2 * 60 * 60 * 1000,
};

const MANIFEST = {
  id: ADDON_ID,
  version: "4.4.0",
  name: "Latanime",
  description: "Anime Latino y Castellano desde latanime.org — con Browser Rendering",
  logo: "https://latanime.org/public/img/logito.png",
  resources: ["catalog", "meta", "stream"],
  types: ["series"],
  catalogs: [
    { type: "series", id: "latanime-latest", name: "Latanime — Recientes", extra: [{ name: "search", isRequired: false }] },
    { type: "series", id: "latanime-airing", name: "Latanime — En Emisión", extra: [] },
    { type: "series", id: "latanime-directory", name: "Latanime — Directorio", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
  ],
  idPrefixes: ["latanime:"],
};

// ─── PROXY LOAD BALANCER ──────────────────────────────────────────────────────
// Rotates through multiple outbound proxy services to bypass IP blocks.
// Each proxy uses a different IP pool — if one is blocked or fails, next is tried.

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CHROME_HEADERS = {
  "User-Agent": CHROME_UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://www.google.com/",
  "Sec-CH-UA": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-CH-UA-Mobile": "?0",
  "Sec-CH-UA-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "cross-site",
  "Cache-Control": "max-age=0",
  "Upgrade-Insecure-Requests": "1",
};

// Each entry: { name, build(url) → fetch-ready URL, extract(response) → Promise<string> }
type ProxyBackend = {
  name: string;
  fetch: (url: string) => Promise<Response>;
};

function buildProxies(url: string, bridgeUrl?: string): ProxyBackend[] {
  const encoded = encodeURIComponent(url);
  const proxies: ProxyBackend[] = [

    // 1. Direct — try first, fastest if not blocked
    {
      name: "direct",
      fetch: () => fetch(url, { headers: CHROME_HEADERS, signal: AbortSignal.timeout(10000) }),
    },

    // 2. AllOrigins — free CORS proxy, different IP pool
    {
      name: "allorigins",
      fetch: () => fetch(`https://api.allorigins.win/raw?url=${encoded}`, {
        headers: { "User-Agent": CHROME_UA },
        signal: AbortSignal.timeout(15000),
      }),
    },

    // 3. CodeTabs proxy — another free proxy service
    {
      name: "codetabs",
      fetch: () => fetch(`https://api.codetabs.com/v1/proxy?quest=${encoded}`, {
        headers: { "User-Agent": CHROME_UA },
        signal: AbortSignal.timeout(15000),
      }),
    },

    // 4. corsproxy.io — yet another IP pool
    {
      name: "corsproxy",
      fetch: () => fetch(`https://corsproxy.io/?${encoded}`, {
        headers: { "User-Agent": CHROME_UA },
        signal: AbortSignal.timeout(15000),
      }),
    },
  ];

  // 5. Bridge (VPS/residential IP) — most reliable, use if set
  if (bridgeUrl) {
    proxies.push({
      name: "bridge",
      fetch: () => fetch(`${bridgeUrl.trim()}/fetch?url=${encoded}`, {
        signal: AbortSignal.timeout(20000),
      }),
    });
  }

  return proxies;
}

async function fetchHtml(url: string, env?: Env): Promise<string> {
  const proxies = buildProxies(url, env?.BRIDGE_URL);

  // Run all proxies in PARALLEL — take the first one that returns valid HTML.
  // Sequential was hitting the 30s Worker wall time limit when multiple proxies failed.
  const tryProxy = async (proxy: ProxyBackend): Promise<string> => {
    const r = await proxy.fetch(url);
    if (!r.ok) throw new Error(`${proxy.name}: HTTP ${r.status}`);
    const html = await r.text();
    if (html.length < 500) throw new Error(`${proxy.name}: response too short (${html.length} chars)`);
    if (proxy.name !== "direct") console.log(`[fetchHtml] Success via ${proxy.name} for ${url}`);
    return html;
  };

  try {
    return await Promise.any(proxies.map(tryProxy));
  } catch (e) {
    throw new Error(`All proxy backends failed for ${url}: ${e}`);
  }
}

async function fetchTmdb(animeName: string, tmdbKey: string) {
  if (!tmdbKey) return null;
  const cleanName = animeName
    .replace(/\s+(Latino|Castellano|Japones|Japonés|Sub\s+Español)$/i, "")
    .replace(/\s+S(\d+)$/i, " Season $1")
    .trim();
  try {
    const r = await fetch(
      `${TMDB_BASE}/search/tv?api_key=${tmdbKey}&query=${encodeURIComponent(cleanName)}&language=es-ES`,
      { headers: { Accept: "application/json" } }
    );
    if (!r.ok) return null;
    const data: any = await r.json();
    const hit = data.results?.[0];
    if (!hit) return null;
    return {
      poster: hit.poster_path ? `${TMDB_IMG}${hit.poster_path}` : "",
      background: hit.backdrop_path ? `https://image.tmdb.org/t/p/w1280${hit.backdrop_path}` : "",
      description: hit.overview || "",
      year: (hit.first_air_date || "").slice(0, 4),
    };
  } catch { return null; }
}

function parseAnimeCards(html: string) {
  const results: { id: string; name: string; poster: string }[] = [];
  const seen = new Set<string>();

  // Wider slug regex: allow any alphanumeric start, dashes, min 2 chars
  for (const m of html.matchAll(/href=["'](?:https?:\/\/latanime\.org)?\/anime\/([a-zA-Z0-9][a-zA-Z0-9-]{1,})["']/gi)) {
    const slug = m[1].toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);

    // Look in a wider window (1000 chars) to catch lazy-loaded layouts
    const pos = m.index! + m[0].length;
    const block = html.slice(Math.max(0, m.index! - 200), pos + 1000);

    const titleM =
      block.match(/<h3[^>]*>([^<]{2,})<\/h3>/i) ||
      block.match(/<h2[^>]*>([^<]{2,})<\/h2>/i) ||
      block.match(/alt="([^"]{2,})"/) ||
      block.match(/title="([^"]{2,})"/) ||
      block.match(/<span[^>]*class="[^"]*title[^"]*"[^>]*>([^<]{2,})<\/span>/i);

    const name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : slug;
    if (!name || name.length < 2) continue;

    const posterM =
      block.match(/data-src="(https?:\/\/latanime\.org\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      block.match(/data-src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      block.match(/data-lazy-src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      block.match(/src="(https?:\/\/latanime\.org\/(?:thumbs|assets|uploads)\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/);

    const poster = posterM
      ? posterM[1].startsWith("http") ? posterM[1] : `${BASE_URL}${posterM[1]}`
      : "";

    results.push({ id: `latanime:${slug}`, name, poster });
  }
  return results.slice(0, 100);
}

function toMetaPreview(c: { id: string; name: string; poster: string }) {
  return { id: c.id, type: "series", name: c.name, poster: c.poster || `${BASE_URL}/public/img/anime.png`, posterShape: "poster" };
}

async function searchAnimes(query: string, env?: Env) {
  // Try AJAX search first — needs CSRF token from homepage
  try {
    const homeHtml = await fetchHtml(`${BASE_URL}/`, env);
    const csrfM = homeHtml.match(/name="csrf-token"[^>]+content="([^"]+)"/i) || homeHtml.match(/content="([^"]+)"[^>]+name="csrf-token"/i);
    const csrf = csrfM ? csrfM[1] : "";
    if (csrf) {
      // POST also needs to go through a proxy since Worker IPs are blocked
      // Use allorigins as relay: it will POST on our behalf if supported,
      // otherwise fall through to search page
      const r = await fetch(`${BASE_URL}/buscar_ajax`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": csrf,
          "X-Requested-With": "XMLHttpRequest",
          "Referer": `${BASE_URL}/`,
          "Origin": BASE_URL,
          "User-Agent": CHROME_UA,
        },
        body: JSON.stringify({ q: query }),
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const html = await r.text();
        const results = parseAnimeCards(html);
        if (results.length > 0) return results;
      }
    }
  } catch { }

  // Fallback: search results page (goes through proxy load balancer)
  return parseAnimeCards(await fetchHtml(`${BASE_URL}/buscar?q=${encodeURIComponent(query)}`, env));
}

async function getCatalog(catalogId: string, extra: Record<string, string>, env?: Env) {
  if (extra.search?.trim()) return { metas: (await searchAnimes(extra.search.trim(), env)).map(toMetaPreview) };
  if (catalogId === "latanime-airing") return { metas: parseAnimeCards(await fetchHtml(`${BASE_URL}/emision`, env)).map(toMetaPreview) };
  if (catalogId === "latanime-directory") {
    const page = Math.floor(parseInt(extra.skip || "0", 10) / 30) + 1;
    return { metas: parseAnimeCards(await fetchHtml(`${BASE_URL}/animes?page=${page}`, env)).map(toMetaPreview) };
  }
  return { metas: parseAnimeCards(await fetchHtml(`${BASE_URL}/`, env)).map(toMetaPreview) };
}

async function getMeta(id: string, tmdbKey: string, env?: Env) {
  const slug = id.replace("latanime:", "");
  const html = await fetchHtml(`${BASE_URL}/anime/${slug}`, env);
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

async function extractMp4upload(embedUrl: string) {
  try {
    const html = await fetchHtml(embedUrl);
    const m = html.match(/"file"\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/) || html.match(/src:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/) || html.match(/file:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function extractHexload(embedUrl: string) {
  try {
    const fileId = embedUrl.split("embed-").pop()?.split(/[/?]/)[0];
    if (!fileId) return null;
    const embedR = await fetch(embedUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", "Referer": "https://latanime.org/" },
    });
    const cookies = embedR.headers.get("set-cookie") || "";
    const r = await fetch("https://hexload.com/download", {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        "Referer": embedUrl, "Origin": "https://hexload.com",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest", "Cookie": cookies,
      },
      body: new URLSearchParams({ op: "download3", id: fileId, ajax: "1", method_free: "1" }).toString(),
    });
    const data: any = await r.json();
    if (data.msg === "OK" && data.result?.url) return data.result.url;
    return null;
  } catch { return null; }
}

async function extractSavefiles(embedUrl: string) {
  try {
    let fileCode: string | null = null;
    const sfMatch = embedUrl.match(/savefiles\.com\/(?:e\/)?([a-z0-9]+)/i);
    const shMatch = embedUrl.match(/streamhls\.to\/e\/([a-z0-9]+)/i);
    if (sfMatch) fileCode = sfMatch[1];
    else if (shMatch) fileCode = shMatch[1];
    if (!fileCode) return null;
    const embedPageUrl = `https://streamhls.to/e/${fileCode}`;
    const dlR = await fetch(`https://streamhls.to/dl`, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        "Referer": embedPageUrl, "Origin": "https://streamhls.to",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      },
      body: `op=embed&file_code=${fileCode}&auto=1&referer=https://savefiles.com/${fileCode}`,
      redirect: "follow",
    });
    const html = await dlR.text();
    // Primary: Clappr sources array (verified pattern from friend)
    const srcMatch = html.match(/sources:\s*\["([^"]+\.m3u8[^"]*)"\]/);
    if (srcMatch) return srcMatch[1];
    // Fallback: any m3u8 URL
    const m3u8Match = html.match(/https:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/);
    if (m3u8Match) return m3u8Match[0];
    return null;
  } catch { return null; }
}

async function extractGofile(folderUrl: string): Promise<{ url: string; token: string } | null> {
  try {
    const folderId = folderUrl.split("/d/").pop()?.split(/[/?]/)[0];
    if (!folderId) return null;
    const accR = await fetch("https://api.gofile.io/accounts", { method: "POST", headers: { "User-Agent": "Mozilla/5.0" } });
    const accData: any = await accR.json();
    const token = accData.data?.token;
    if (!token) return null;
    const contentR = await fetch(`https://api.gofile.io/contents/${folderId}?cache=true`, {
      headers: { "Authorization": `Bearer ${token}`, "X-Website-Token": "4fd6sg89d7s6", "User-Agent": "Mozilla/5.0" }
    });
    const contentData: any = await contentR.json();
    if (contentData.status !== "ok") return null;
    const children = contentData.data?.children;
    if (!children) return null;
    const fileId = Object.keys(children).find(id => children[id].mimetype?.startsWith("video/"));
    if (!fileId) return null;
    return { url: children[fileId].link, token };
  } catch { return null; }
}

function extractPixeldrain(embedUrl: string): string | null {
  const m = embedUrl.match(/pixeldrain\.com\/u\/([a-zA-Z0-9]+)/);
  if (!m) return null;
  return `https://pixeldrain.com/api/file/${m[1]}/download`;
}

async function extractMediafire(mfUrl: string): Promise<string | null> {
  try {
    const res = await fetch(mfUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        "Referer": "https://www.mediafire.com/",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      }
    });
    const html = await res.text();
    const m = html.match(/https:\/\/download\d+\.mediafire\.com[^"'\s]+/);
    if (m) return m[0];
    const btn = html.match(/href="(https:\/\/download\d+\.mediafire\.com[^"]+)"/);
    return btn ? btn[1] : null;
  } catch { return null; }
}

async function extractViaBridge(embedUrl: string, bridgeUrl: string) {
  try {
    const r = await fetch(`${bridgeUrl}/extract?url=${encodeURIComponent(embedUrl)}`, { signal: AbortSignal.timeout(50000) });
    if (!r.ok) return null;
    const data: any = await r.json();
    return data.url || null;
  } catch { return null; }
}

// ─── GOFILE ──────────────────────────────────────────────────────────────────
// API flow: get guest token → fetch content → extract direct link
async function extractGofile(gofileUrl: string): Promise<string | null> {
  try {
    const codeM = gofileUrl.match(/gofile\.io\/(?:d|download)\/([a-zA-Z0-9]+)/);
    if (!codeM) return null;
    const contentId = codeM[1];

    // Step 1: get guest token
    const tokenR = await fetch("https://api.gofile.io/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!tokenR.ok) return null;
    const tokenData: any = await tokenR.json();
    const token = tokenData?.data?.token;
    if (!token) return null;

    // Step 2: fetch content
    const contentR = await fetch(
      `https://api.gofile.io/contents/${contentId}?wt=4fd6sg89d7s6`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!contentR.ok) return null;
    const content: any = await contentR.json();
    const children = content?.data?.children;
    if (!children) return null;

    // Find first video file
    for (const child of Object.values(children) as any[]) {
      if (child.type === "file" && child.mimetype?.startsWith("video/")) {
        return child.link || null;
      }
    }
    return null;
  } catch { return null; }
}

// ─── STREAMTAPE ───────────────────────────────────────────────────────────────
// Page contains obfuscated JS: the token is split across two strings that need concat
async function extractStreamtape(embedUrl: string): Promise<string | null> {
  try {
    const r = await fetch(embedUrl, {
      headers: {
        "User-Agent": CHROME_UA,
        "Referer": "https://latanime.org/",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const html = await r.text();

    // Pattern: robotlink innerHTML set via JS string concat
    // id="robotlink")</s> ... ('//streamtape.com/get_video?id=X&expires=Y&ip=Z&token=ABC' + 'DEF')
    const m = html.match(/robotlink[^>]*>[^<]*<\/[^>]+>[\s\S]*?get_video\?[^'"]+['"]([^'"]+)['"]\s*\+\s*['"]([^'"]+)['"]/);
    if (m) return `https:${m[1]}${m[2]}`;

    // Fallback: direct get_video URL
    const direct = html.match(/["'](\/\/streamtape\.com\/get_video\?[^"']+)["']/);
    if (direct) return `https:${direct[1]}`;

    return null;
  } catch { return null; }
}

// ─── STREAMWISH / FILELIONS / WISHEMBED ───────────────────────────────────────
// These share the same player engine — POST to /api/source/{id} to get m3u8
async function extractStreamwish(embedUrl: string): Promise<string | null> {
  try {
    const idM = embedUrl.match(/\/(?:e\/|f\/)?([a-zA-Z0-9]{8,})\/?(?:\?|$)/);
    if (!idM) return null;
    const fileId = idM[1];

    // Get base domain from embed URL
    const base = new URL(embedUrl).origin;

    const r = await fetch(`${base}/api/source/${fileId}`, {
      method: "POST",
      headers: {
        "User-Agent": CHROME_UA,
        "Referer": embedUrl,
        "Origin": base,
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: `r=&d=${encodeURIComponent(base)}`,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data: any = await r.json();

    // Returns { success: true, data: [{ file, label, type }] }
    const sources: any[] = data?.data || [];
    const hls = sources.find((s: any) => s.type === "hls" || s.file?.includes(".m3u8"));
    if (hls?.file) return hls.file;
    const mp4 = sources.find((s: any) => s.file?.includes(".mp4"));
    if (mp4?.file) return mp4.file;
    return null;
  } catch { return null; }
}

// ─── VIDGUARD ─────────────────────────────────────────────────────────────────
// Heavily obfuscated — needs page fetch + eval-style decoding
// Pattern: encoded string in `_0x...` vars, but the m3u8 URL leaks in source
async function extractVidguard(embedUrl: string): Promise<string | null> {
  try {
    const r = await fetch(embedUrl, {
      headers: {
        "User-Agent": CHROME_UA,
        "Referer": "https://latanime.org/",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const html = await r.text();

    // Look for stream URL in source (sometimes leaks unobfuscated)
    const m3u8 = html.match(/["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)["'`]/);
    if (m3u8) return m3u8[1];

    // vgfplay/vidguard API pattern
    const srcM = html.match(/source\s*:\s*["']([^"']+\.m3u8[^"']*)["']/);
    if (srcM) return srcM[1];

    return null;
  } catch { return null; }
}

async function extractWithBrowser(embedUrl: string, env: Env): Promise<string | null> {
  if (!env.MYBROWSER) return null;
  const puppeteerMod: any = await import("@cloudflare/puppeteer");
  const puppeteer = puppeteerMod.default;

  const cacheKey = `br:${embedUrl}`;
  if (env.STREAM_CACHE) {
    const cached = await env.STREAM_CACHE.get(cacheKey);
    if (cached) {
      console.log(`[browser] KV cache hit for ${embedUrl}`);
      return cached;
    }
  }

  let browser = null;
  try {
    let sessionId: string | undefined;
    try {
      const sessions = await (puppeteer as any).sessions(env.MYBROWSER);
      const free = sessions.filter((s: any) => !s.connectionId);
      if (free.length > 0) {
        sessionId = free[Math.floor(Math.random() * free.length)].sessionId;
        console.log(`[browser] Reusing session ${sessionId}`);
      }
    } catch { }

    browser = sessionId
      ? await puppeteer.connect(env.MYBROWSER, sessionId)
      : await puppeteer.launch(env.MYBROWSER);

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36");

    // Spoof user activation so autoplay works without real click
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "userActivation", {
        get: () => ({ isActive: true, hasBeenActive: true }),
        configurable: true,
      });
    });

    await page.setRequestInterception(true);

    const BLOCK_TYPES = new Set(["image", "font", "media"]);
    const BLOCK_HOSTS = ["google-analytics", "googletagmanager", "doubleclick", "facebook", "twitter", "adsbygoogle", "turnstile.cf"];

    page.on("request", (req: any) => {
      const type = req.resourceType();
      const url = req.url();
      if (BLOCK_TYPES.has(type) || BLOCK_HOSTS.some((h) => url.includes(h))) {
        req.abort();
      } else {
        req.continue();
      }
    });

    let streamUrl: string | null = null;
    page.on("response", async (res: any) => {
      if (streamUrl) return;
      const url = res.url();
      // Intercept m3u8 playlist requests
      if (
        (url.includes(".m3u8") || url.includes("/playlist") || url.includes("/master")) &&
        !url.includes("latanime.org")
      ) {
        streamUrl = url;
        console.log(`[browser] Intercepted m3u8: ${url}`);
        return;
      }
      // Intercept JSON API responses that contain m3u8 URLs
      const ct = res.headers()["content-type"] || "";
      if (ct.includes("json") && !url.includes("latanime.org")) {
        try {
          const text = await res.text();
          const m = text.match(/["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/);
          if (m) {
            streamUrl = m[1];
            console.log(`[browser] Found m3u8 in JSON response: ${streamUrl}`);
          }
        } catch {}
      }
    });

    await Promise.race([
      page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 30000 }),
      new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (streamUrl) { clearInterval(interval); resolve(); }
        }, 300);
        setTimeout(() => clearInterval(interval), 30000);
      }),
    ]);

    // Click play button if no stream found yet (handles click-to-play shells like streamhls)
    if (!streamUrl) {
      try {
        const playSelectors = [
          "#vid_play", ".play-button", "[id*='play']", "[class*='play']",
          "button", ".jw-icon-display", ".vjs-big-play-button", "video"
        ];
        for (const sel of playSelectors) {
          const el = await page.$(sel);
          if (el) {
            await el.click();
            console.log(`[browser] Clicked: ${sel}`);
            break;
          }
        }
        // Wait up to 25s for stream after click (SPA players need time to boot + API call)
        const deadline = Date.now() + 25000;
        while (!streamUrl && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 300));
        }
      } catch(e) { console.log("[browser] Click failed:", e); }
    }

    if (!streamUrl) {
      streamUrl = await (page.evaluate as any)(() => {
        const video = (document as any).querySelector("video");
        if (video?.src && !video.src.startsWith("blob:")) return video.src;
        const source = (document as any).querySelector("video source");
        return source?.getAttribute("src") || null;
      });
    }

    if (!streamUrl) {
      streamUrl = await (page.evaluate as any)(() => {
        const scripts = Array.from((document as any).querySelectorAll("script:not([src])")).map((s: any) => (s as any).textContent || "");
        const combined = scripts.join("\n");
        const m =
          combined.match(/["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)["'`]/) ||
          combined.match(/"file"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/) ||
          combined.match(/source\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/);
        return m ? m[1] : null;
      });
    }

    await page.close();

    if (streamUrl && env.STREAM_CACHE) {
      await env.STREAM_CACHE.put(cacheKey, streamUrl, { expirationTtl: TTL.browserStream / 1000 });
      console.log(`[browser] Cached to KV: ${streamUrl}`);
    }

    return streamUrl;
  } catch (e) {
    console.error("[browser] Error:", e);
    return null;
  } finally {
    if (browser) {
      try { browser.disconnect(); } catch { }
    }
  }
}

// ─── MEDIAFIRE RESOLVER ────────────────────────────────────────────────────
// Verified Feb 27 2026: GET mediafire.com/file/{key}/{name}/file
// → HTML contains CDN URL: download{n}.mediafire.com/.../{key}/{filename}
// → 206 Partial Content, video/mp4, Accept-Ranges: bytes ✓
async function resolveMediafire(mfUrl: string): Promise<string | null> {
  try {
    const r = await fetch(mfUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        "Referer": "https://www.mediafire.com/",
        "Accept-Language": "es-MX,es;q=0.9",
      },
    });
    if (!r.ok) return null;
    const html = await r.text();
    const match = html.match(/https:\/\/download\d+\.mediafire\.com[^"'\s]+/);
    if (match) return match[0];
    // Fallback: download button href
    const btnMatch = html.match(/aria-label="Download file"[^>]+href="([^"]+)"|href="([^"]+)"[^>]*id="downloadButton"|href="([^"]+)"[^>]*class="[^"]*popsok/);
    if (btnMatch) return btnMatch[1] || btnMatch[2] || btnMatch[3];
    return null;
  } catch { return null; }
}

async function getStreams(rawId: string, env: Env, request: Request) {
  const parts = rawId.replace("latanime:", "").split(":");
  if (parts.length < 2) return { streams: [] };
  const [slug, epNum] = parts;

  const html = await fetchHtml(`${BASE_URL}/ver/${slug}-episodio-${epNum}`, env);
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

  // Scrape download mirror links directly from episode page
  const mirrors: { mediafire?: string; savefiles?: string; pixeldrain?: string; mega?: string; gofile?: string; streamtape?: string } = {};
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = m[1].trim();
    if (href.includes("mediafire.com") && href.includes("/file/") && !mirrors.mediafire) mirrors.mediafire = href;
    else if (href.includes("savefiles.com") && !href.includes("/d/") && !mirrors.savefiles) mirrors.savefiles = href;
    else if (href.includes("pixeldrain.com") && !mirrors.pixeldrain) mirrors.pixeldrain = href;
    else if (href.includes("mega.nz") && !mirrors.mega) mirrors.mega = href;
    else if (href.includes("gofile.io") && !mirrors.gofile) mirrors.gofile = href;
    else if (href.includes("streamtape.com") && !mirrors.streamtape) mirrors.streamtape = href;
  }

  if (embedUrls.length === 0 && Object.keys(mirrors).length === 0) return { streams: [] };

  const bridgeUrl = (env.BRIDGE_URL || "").trim();
  const mfpBase = (env.MFP_URL || "").trim().replace(/\/$/, "");
  const mfpPass = (env.MFP_PASSWORD || "latanime").trim();
  const workerBase = new URL(request.url).origin;

  function hlsProxyUrl(m3u8Url: string, referer: string) {
    // Use MFP if explicitly configured, otherwise use our own worker proxy
    if (mfpBase) {
      const params = new URLSearchParams({
        d: m3u8Url,
        h_Referer: referer,
        h_Origin: new URL(referer).origin,
        api_password: mfpPass,
      });
      return `${mfpBase}/proxy/hls/manifest.m3u8?${params}`;
    }
    return `${workerBase}/proxy/m3u8?url=${encodeURIComponent(m3u8Url)}&ref=${encodeURIComponent(referer)}`;
  }

  const BROWSER_PLAYERS = ["filemoon", "voe.sx", "lancewhosedifficult", "voeunblocked", "mxdrop", "dsvplay", "doodstream", "uqload", "upstream"];
  const needsBrowser = (url: string) => BROWSER_PLAYERS.some((p) => url.includes(p));

  const streams: any[] = [];
  const extractedNames = new Set<string>();

  // Build task list — embeds + savefiles mirror (all run in parallel)
  const mirrorTasks: Promise<{ url: string; name: string; isHls: boolean } | null>[] = [];

  // Priority 1: MediaFire — direct MP4, seekable, no expiry, ~185MB/ep
  if (mirrors.mediafire) {
    mirrorTasks.push((async () => {
      const cdnUrl = await resolveMediafire(mirrors.mediafire!);
      if (!cdnUrl) return null;
      return { url: cdnUrl, name: "🔥 MediaFire MP4", isHls: false };
    })());
  }

  if (mirrors.savefiles) {
    const sfCode = mirrors.savefiles.split("savefiles.com/").pop()?.split(/[/?]/)[0]?.trim();
    if (sfCode && sfCode.length > 3) {
      mirrorTasks.push((async () => {
        const m3u8 = await extractSavefiles(`https://savefiles.com/${sfCode}`);
        if (!m3u8) return null;
        return { url: m3u8, name: "savefiles 1080p", isHls: true };
      })());
    }
  }
  if (mirrors.gofile) {
    mirrorTasks.push((async () => {
      const res = await extractGofile(mirrors.gofile!);
      if (!res) return null;
      const proxyUrl = `${workerBase}/proxy/file?url=${encodeURIComponent(res.url)}&token=${encodeURIComponent(res.token)}`;
      return { url: proxyUrl, name: "Gofile", isHls: false };
    })());
  }

  // GoFile — free direct download, no account needed
  if (mirrors.gofile) {
    mirrorTasks.push((async () => {
      const url = await extractGofile(mirrors.gofile!);
      if (!url) return null;
      return { url, name: "📂 GoFile MP4", isHls: false };
    })());
  }

  // StreamTape mirror link
  if (mirrors.streamtape) {
    mirrorTasks.push((async () => {
      const url = await extractStreamtape(mirrors.streamtape!);
      if (!url) return null;
      return { url, name: "📼 StreamTape MP4", isHls: false };
    })());
  }

  const results = await Promise.allSettled([
    ...mirrorTasks,
    ...embedUrls.map(async (embed) => {
      // Pixeldrain — direct stream, Stremio fetches from user's residential IP
      if (embed.url.includes("pixeldrain.com")) {
        const idM = embed.url.match(/pixeldrain\.com\/(?:u\/|l\/)([a-zA-Z0-9]+)/);
        if (idM) return { url: `https://pixeldrain.com/api/file/${idM[1]}`, name: embed.name, isHls: false };
        return null;
      }

      if (embed.url.includes("hexload.com")) {
        const url = await extractHexload(embed.url);
        return url ? { url, name: embed.name, isHls: false } : null;
      }
      if (embed.url.includes("mp4upload.com")) {
        const url = await extractMp4upload(embed.url);
        return url ? { url, name: embed.name, isHls: false } : null;
      }
      if (embed.url.includes("savefiles.com") || embed.url.includes("streamhls.to")) {
        const url = await extractSavefiles(embed.url);
        return url ? { url, name: embed.name, isHls: url.includes(".m3u8") } : null;
      }
      if (embed.url.includes("streamtape.com") || embed.url.includes("streamtape.net")) {
        const url = await extractStreamtape(embed.url);
        return url ? { url, name: embed.name, isHls: false } : null;
      }
      if (
        embed.url.includes("streamwish.") || embed.url.includes("wishembed.") ||
        embed.url.includes("filelions.") || embed.url.includes("streamwish.to") ||
        embed.url.includes("ajmidyad.sbs") || embed.url.includes("kibagames.best")
      ) {
        const url = await extractStreamwish(embed.url);
        return url ? { url, name: embed.name, isHls: url.includes(".m3u8") } : null;
      }
      if (embed.url.includes("vidguard.") || embed.url.includes("vgfplay.")) {
        const url = await extractVidguard(embed.url);
        if (url) return { url, name: embed.name, isHls: url.includes(".m3u8") };
        const bUrl = await extractWithBrowser(embed.url, env);
        if (bUrl) return { url: bUrl, name: embed.name, isHls: bUrl.includes(".m3u8") };
        return null;
      }
      if (needsBrowser(embed.url)) {
        let url = await extractWithBrowser(embed.url, env);
        if (!url && bridgeUrl) url = await extractViaBridge(embed.url, bridgeUrl);
        return url ? { url, name: embed.name, isHls: url.includes(".m3u8") } : null;
      }
      if (bridgeUrl) {
        const url = await extractViaBridge(embed.url, bridgeUrl);
        if (url) return { url, name: embed.name, isHls: url.includes(".m3u8") };
      }
      return null;
    })
  ]);

  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      const { url: streamUrl, name, isHls } = r.value;
      const isSavefiles = streamUrl.includes("savefiles.com") || streamUrl.includes("s3.savefiles") || streamUrl.includes("s2.savefiles") || streamUrl.includes("streamhls.to");
      let finalUrl: string;
      if (isHls && isSavefiles) {
        finalUrl = hlsProxyUrl(streamUrl, "https://streamhls.to/");
      } else if (isHls) {
        finalUrl = hlsProxyUrl(streamUrl, "https://latanime.org/");
      } else {
        finalUrl = streamUrl;
      }
      if (!streams.some(s => s.url === finalUrl)) {
        const isMediafire = name.includes("MediaFire");
        const entry = { url: finalUrl, title: `▶ ${name} — Latino`, behaviorHints: { notWebReady: isHls } };
        if (isMediafire) streams.unshift(entry); else streams.push(entry);
      }
      extractedNames.add(name);
      // 480p variant for savefiles streams
      if (isHls && isSavefiles) {
        const m3u8_480 = streamUrl.replace(",_n,", ",_l,").replace("_n,", "_l,");
        if (m3u8_480 !== streamUrl) {
          const url480 = hlsProxyUrl(m3u8_480, "https://streamhls.to/");
          if (!streams.some(s => s.url === url480)) {
            streams.push({ url: url480, title: `▶ ${name} 480p — Latino`, behaviorHints: { notWebReady: true } });
          }
        }
      }
    }
  }

  for (const embed of embedUrls) {
    if (!extractedNames.has(embed.name)) {
      streams.push({ url: embed.url, title: `🌐 ${embed.name} — Latino`, behaviorHints: { notWebReady: true } });
    }
  }

  // Resolve download mirrors in parallel with embed extraction (already done above)
  // Pixeldrain — instant, no async needed
  if (mirrors.pixeldrain) {
    const idM = mirrors.pixeldrain.match(/pixeldrain\.com\/u\/([a-zA-Z0-9]+)/);
    if (idM) {
      const pdUrl = `https://pixeldrain.com/api/file/${idM[1]}`;
      if (!streams.some(s => s.url === pdUrl)) {
        streams.unshift({ url: pdUrl, title: "▶ Pixeldrain — Latino", behaviorHints: { notWebReady: true } });
      }
    }
  }

  return { streams };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const tmdbKey = (env.TMDB_KEY || "").trim();
    const bridgeUrl = (env.BRIDGE_URL || "").trim();

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (path === "/" || path === "/manifest.json") return json(MANIFEST);

    if (path === "/debug") {
      return json({ tmdbKey: tmdbKey ? "set" : "not set", bridgeUrl: bridgeUrl || "not set", browserBinding: env.MYBROWSER ? "set" : "not set", kvBinding: env.STREAM_CACHE ? "set" : "not set" });
    }

    if (path === "/debug-browser") {
      const testUrl = url.searchParams.get("url");
      if (!testUrl) return json({ error: "Missing ?url=" });
      const t0 = Date.now();
      const result = await extractWithBrowser(testUrl, env);
      return json({ streamUrl: result, ms: Date.now() - t0 });
    }

    if (path === "/debug-host") {
      const embedUrl = url.searchParams.get("url");
      if (!embedUrl) return new Response("Missing url", { status: 400 });
      const hdrs = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", "Referer": "https://latanime.org/", "Origin": "https://latanime.org", "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "es-ES,es;q=0.9" };
      try {
        const r = await fetch(embedUrl, { headers: hdrs });
        const html = await r.text();
        const urls = [...html.matchAll(/["'`](https?:\/\/[^"'`\s]{15,}\.(?:mp4|mkv|m3u8|ts)[^"'`\s]*)/gi)].map((m) => m[1]);
        return Response.json({ status: r.status, contentType: r.headers.get("content-type"), htmlLen: html.length, foundUrls: urls, htmlSnippet: html.slice(0, 5000) }, { headers: CORS });
      } catch (e) { return Response.json({ error: String(e) }, { headers: CORS }); }
    }

    if (path === "/debug-savefiles") {
      const code = url.searchParams.get("code") || "hxhufbkiftyf";
      const t0 = Date.now();
      const streamUrl = await extractSavefiles(`https://savefiles.com/${code}`);
      const workerBase = new URL(request.url).origin;
      const proxyUrl = streamUrl ? `${workerBase}/proxy/m3u8?url=${encodeURIComponent(streamUrl)}&ref=${encodeURIComponent("https://streamhls.to/")}` : null;
      return json({ code, streamUrl, proxyUrl, ms: Date.now() - t0 });
    }

    if (path === "/debug-search") {
      const q = url.searchParams.get("q");
      if (!q) return json({ error: "Missing ?q=" });
      const t0 = Date.now();
      try {
        const results = await searchAnimes(q, env);
        return json({ query: q, count: results.length, results, ms: Date.now() - t0 });
      } catch (e) { return json({ error: String(e), ms: Date.now() - t0 }); }
    }

    if (path === "/debug-proxy") {
      const testUrl = url.searchParams.get("url") || BASE_URL;
      const t0 = Date.now();
      try {
        const html = await fetchHtml(testUrl, env);
        return json({ url: testUrl, htmlLen: html.length, snippet: html.slice(0, 1000), ms: Date.now() - t0 });
      } catch (e) { return json({ error: String(e), ms: Date.now() - t0 }); }
    }

    if (path === "/debug-bridge") {
      const testUrl = url.searchParams.get("url") || "https://luluvid.com/e/t66o00zj95a9";
      if (!bridgeUrl) return json({ error: "BRIDGE_URL not set" });
      const t0 = Date.now();
      try {
        const r = await fetch(`${bridgeUrl}/extract?url=${encodeURIComponent(testUrl)}`, { signal: AbortSignal.timeout(50000) });
        const body = await r.text();
        return json({ status: r.status, body, testUrl, bridgeUrl, ms: Date.now() - t0 });
      } catch (e) { return json({ error: String(e), testUrl, bridgeUrl, ms: Date.now() - t0 }); }
    }

    if (path === "/cache-clear") {
      const key = url.searchParams.get("key");
      if (key && env.STREAM_CACHE) {
        await env.STREAM_CACHE.delete(`br:${key}`);
        return json({ cleared: key });
      }
      return json({ error: "Missing ?key= or no KV binding" });
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
      try { const result = await getCatalog(catalogId, extra, env); cacheSet(cacheKey, result, TTL.catalog); return json(result); }
      catch (e) { return json({ metas: [], error: String(e) }); }
    }

    const metaM = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
    if (metaM) {
      const id = decodeURIComponent(metaM[2]);
      const cached = cacheGet(`meta:${id}`);
      if (cached) return json(cached);
      try { const result = await getMeta(id, tmdbKey, env); cacheSet(`meta:${id}`, result, TTL.meta); return json(result); }
      catch (e) { return json({ meta: null, error: String(e) }); }
    }

    const streamM = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (streamM) {
      const id = decodeURIComponent(streamM[2]);
      const cached = cacheGet(`stream:${id}`);
      if (cached) return json(cached);
      try {
        const result = await getStreams(id, env, request);
        if (result.streams.length > 0) cacheSet(`stream:${id}`, result, TTL.stream);
        return json(result);
      } catch (e) { return json({ streams: [], error: String(e) }); }
    }

    if (path === "/proxy/file") {
      const fileUrl = url.searchParams.get("url");
      const token = url.searchParams.get("token");
      if (!fileUrl) return new Response("Missing url", { status: 400 });
      try {
        const parsedUrl = new URL(fileUrl);
        if (!parsedUrl.hostname.endsWith(".gofile.io")) return new Response("Forbidden domain", { status: 403 });
      } catch { return new Response("Invalid URL", { status: 400 }); }
      try {
        const range = request.headers.get("Range");
        const hdrs: any = { "Cookie": `accountToken=${token}`, "User-Agent": "Mozilla/5.0", "Referer": "https://gofile.io/" };
        if (range) hdrs["Range"] = range;
        const r = await fetch(fileUrl, { headers: hdrs });
        const resHeaders = new Headers(r.headers);
        resHeaders.set("Access-Control-Allow-Origin", "*");
        resHeaders.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
        return new Response(r.body, { status: r.status, statusText: r.statusText, headers: resHeaders });
      } catch (e) { return new Response(String(e), { status: 500 }); }
    }

    if (path === "/proxy/m3u8") {
      const m3u8Url = url.searchParams.get("url");
      const referer = url.searchParams.get("ref") || "https://latanime.org/";
      if (!m3u8Url) return new Response("Missing url", { status: 400 });
      try {
        const decoded = decodeURIComponent(m3u8Url);
        const base = decoded.substring(0, decoded.lastIndexOf("/") + 1);
        const workerBase = new URL(request.url).origin;
        const r = await fetch(decoded, { headers: { "Referer": referer, "Origin": new URL(referer).origin, "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1" } });
        if (!r.ok) return new Response(`Upstream ${r.status}`, { status: r.status });
        const m3u8Text = await r.text();
        const isMaster = m3u8Text.includes("#EXT-X-STREAM-INF");
        const rewritten = m3u8Text.split("\n").map((line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith("#") || trimmed === "") return line;
          const absUrl = trimmed.startsWith("http") ? trimmed : base + trimmed;
          if (isMaster || absUrl.includes(".m3u8")) return `${workerBase}/proxy/m3u8?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer)}`;
          return `${workerBase}/proxy/seg?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer)}`;
        }).join("\n");
        return new Response(rewritten, { headers: { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" } });
      } catch (e) { return new Response(String(e), { status: 500 }); }
    }

    if (path === "/proxy/seg") {
      const segUrl = url.searchParams.get("url");
      const referer = url.searchParams.get("ref") || "https://latanime.org/";
      if (!segUrl) return new Response("Missing url", { status: 400 });
      try {
        const decoded = decodeURIComponent(segUrl);
        const r = await fetch(decoded, { headers: { "Referer": referer, "Origin": new URL(referer).origin, "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1" } });
        if (!r.ok) return new Response(`Upstream ${r.status}`, { status: r.status });
        return new Response(r.body, { headers: { "Content-Type": r.headers.get("Content-Type") || "video/MP2T", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } });
      } catch (e) { return new Response(String(e), { status: 500 }); }
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
