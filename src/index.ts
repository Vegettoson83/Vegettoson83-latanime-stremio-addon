/**
 * LATANIME STREMIO ADDON — v1.1
 * Cloudflare Worker — Serverless, Free Tier
 */

const ADDON_ID = "com.latanime.stremio";
const BASE_URL = "https://latanime.org";
// Env vars are set per-request from the Worker env object
let TMDB_KEY = "";
let BRIDGE_URL = "";
let BRIDGE_KEY = "";

async function extractViaBridge(embedUrl: string): Promise<string | null> {
  if (!BRIDGE_URL) return null;
  try {
    const r = await fetch(
      `${BRIDGE_URL}/extract?url=${encodeURIComponent(embedUrl)}`,
      {
        headers: { "x-api-key": BRIDGE_KEY },
        signal: AbortSignal.timeout(25000),
      }
    );
    if (!r.ok) return null;
    const data = await r.json() as { url?: string };
    return data.url || null;
  } catch {
    return null;
  }
}
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";

async function fetchTmdb(animeName: string): Promise<{ poster: string; background: string; description: string; year: string; genres: string[] } | null> {
  if (!TMDB_KEY) return null;
  // Strip language suffix (Latino, Castellano) for better TMDB match
  const cleanName = animeName
    .replace(/\s+(Latino|Castellano|Japones|Japonés|Sub\s+Español)$/i, "")
    .replace(/\s+S(\d+)$/i, " Season $1")
    .trim();
  try {
    const r = await fetch(
      `${TMDB_BASE}/search/tv?api_key=${TMDB_KEY}&query=${encodeURIComponent(cleanName)}&language=es-ES`,
      { headers: { Accept: "application/json" } }
    );
    if (!r.ok) return null;
    const data = await r.json() as { results?: any[] };
    const hit = data.results?.[0];
    if (!hit) return null;
    return {
      poster: hit.poster_path ? `${TMDB_IMG}${hit.poster_path}` : "",
      background: hit.backdrop_path ? `https://image.tmdb.org/t/p/w1280${hit.backdrop_path}` : "",
      description: hit.overview || "",
      year: hit.first_air_date?.slice(0, 4) || "",
      genres: [],
    };
  } catch { return null; }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

const CACHE = new Map<string, { data: unknown; expires: number }>();

function cacheGet(key: string): unknown | null {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { CACHE.delete(key); return null; }
  return entry.data;
}

function cacheSet(key: string, data: unknown, ttlMs = 5 * 60 * 1000) {
  CACHE.set(key, { data, expires: Date.now() + ttlMs });
}

const MANIFEST = {
  id: ADDON_ID,
  version: "1.1.0",
  name: "Latanime",
  description: "Anime Latino y Castellano desde latanime.org",
  logo: "https://latanime.org/public/img/logito.png",
  resources: ["catalog", "meta", "stream"],
  types: ["series"],
  catalogs: [
    {
      type: "series",
      id: "latanime-latest",
      name: "Latanime — Recientes",
      extra: [{ name: "search", isRequired: false }],
    },
    {
      type: "series",
      id: "latanime-airing",
      name: "Latanime — En Emisión",
      extra: [],
    },
    {
      type: "series",
      id: "latanime-directory",
      name: "Latanime — Directorio",
      extra: [{ name: "search", isRequired: false }],
    },
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

function parseAnimeCards(html: string): { id: string; name: string; poster: string }[] {
  const results: { id: string; name: string; poster: string }[] = [];
  const seen = new Set<string>();

  // Find all /anime/slug links and grab surrounding context for title/poster
  for (const m of html.matchAll(
    /href=["'](?:https?:\/\/latanime\.org)?\/anime\/([a-z0-9][a-z0-9-]+)["']/gi
  )) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);

    // Grab up to 600 chars after the link for poster/title
    const pos = m.index! + m[0].length;
    const block = html.slice(pos, pos + 600);

    // Title: h3 first (search/directory pages), then alt, then title attribute
    const titleM =
      block.match(/<h3[^>]*>([^<]{3,})<\/h3>/i) ||
      block.match(/alt="([^"]{3,})"/) ||
      block.match(/title="([^"]{3,})"/);
    const name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : slug;

    // Poster: data-src preferred (lazy load), then src
    const posterM =
      block.match(/data-src="(https?:\/\/latanime\.org\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      block.match(/data-src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      block.match(/src="(https?:\/\/latanime\.org\/(?:thumbs|assets)\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/);
    const poster = posterM
      ? (posterM[1].startsWith("http") ? posterM[1] : BASE_URL + posterM[1])
      : "";

    // Skip nav/menu links (they appear in navbar too)
    if (!name || name.length < 2) continue;

    results.push({ id: "latanime:" + slug, name, poster });
  }

  return results.slice(0, 100);
}

function toMetaPreview(card: { id: string; name: string; poster: string }) {
  return {
    id: card.id,
    type: "series",
    name: card.name,
    poster: card.poster || `${BASE_URL}/public/img/anime.png`,
    posterShape: "poster",
  };
}

async function searchAnimes(query: string): Promise<{ id: string; name: string; poster: string }[]> {
  // Step 1: get CSRF token from homepage
  const homeHtml = await fetchHtml(BASE_URL + "/");
  const csrfM = homeHtml.match(/name="csrf-token"[^>]+content="([^"]+)"/i)
    || homeHtml.match(/content="([^"]+)"[^>]+name="csrf-token"/i);
  const csrf = csrfM ? csrfM[1] : "";

  // Step 2: POST to /buscar_ajax
  try {
    const r = await fetch(`${BASE_URL}/buscar_ajax`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": csrf,
        "X-Requested-With": "XMLHttpRequest",
        "Referer": BASE_URL + "/",
        "Origin": BASE_URL,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      },
      body: JSON.stringify({ q: query }),
    });
    if (r.ok) {
      const html = await r.text();
      const results = parseAnimeCards(html);
      if (results.length > 0) return results;
    }
  } catch { /* fall through */ }

  // Fallback: scrape /buscar
  const html = await fetchHtml(`${BASE_URL}/buscar?q=${encodeURIComponent(query)}`);
  return parseAnimeCards(html);
}

async function getCatalog(catalogId: string, extra: Record<string, string>) {
  const search = extra.search?.trim();
  if (search) {
    const results = await searchAnimes(search);
    return { metas: results.map(toMetaPreview) };
  }
  if (catalogId === "latanime-airing") {
    const html = await fetchHtml(`${BASE_URL}/emision`);
    return { metas: parseAnimeCards(html).map(toMetaPreview) };
  }
  if (catalogId === "latanime-directory") {
    const html = await fetchHtml(`${BASE_URL}/animes`);
    return { metas: parseAnimeCards(html).map(toMetaPreview) };
  }
  const html = await fetchHtml(`${BASE_URL}/`);
  return { metas: parseAnimeCards(html).map(toMetaPreview) };
}

async function getMeta(id: string) {
  const slug = id.replace("latanime:", "");
  const html = await fetchHtml(`${BASE_URL}/anime/${slug}`);

  // Title is in <h2> tag
  const titleM =
    html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) ||
    html.match(/<title>(.*?)\s*[—\-|].*?<\/title>/i);
  const name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : slug;

  // Poster: og:image meta tag is most reliable
  const posterM =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) ||
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i) ||
    html.match(/src="(https?:\/\/latanime\.org\/thumbs\/imagen\/[^"]+)"/i);
  const poster = posterM ? posterM[1] : "";

  // Description: <p class="my-2 opacity-75">
  const descM =
    html.match(/<p[^>]*class="[^"]*opacity[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
    html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i) ||
    html.match(/<meta[^>]+content="([^"]+)"[^>]+name="description"/i);
  const description = descM ? descM[1].replace(/<[^>]+>/g, "").trim() : "";

  // Genres: <a href="/genero/..."><div class="btn">Genre</div></a>
  const genres: string[] = [];
  for (const gm of html.matchAll(/href="[^"]*\/genero\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const g = gm[1].replace(/<[^>]+>/g, "").trim();
    if (g) genres.push(g);
  }

  // Episodes: <a href="/ver/slug-episodio-N">
  const episodes: { id: string; number: number; epSlug: string }[] = [];
  const seenEps = new Set<string>();
  for (const em of html.matchAll(
    /href=["'](?:https?:\/\/latanime\.org)?\/ver\/([a-z0-9-]+-episodio-(\d+(?:\.\d+)?))["']/gi
  )) {
    if (seenEps.has(em[1])) continue;
    seenEps.add(em[1]);
    episodes.push({
      id: `latanime:${slug}:${parseFloat(em[2])}`,
      number: parseFloat(em[2]),
      epSlug: em[1],
    });
  }
  episodes.sort((a, b) => a.number - b.number);

  // Enrich with TMDB if available
  const tmdb = await fetchTmdb(name);
  const finalPoster = (tmdb?.poster) || poster;
  const finalBg = (tmdb?.background) || poster;
  const finalDesc = (tmdb?.description) || description;

  return {
    meta: {
      id,
      type: "series",
      name,
      poster: finalPoster,
      posterShape: "poster",
      background: finalBg,
      description: finalDesc,
      genres: genres.slice(0, 10),
      releaseInfo: tmdb?.year || "",
      videos: episodes.map((ep) => ({
        id: ep.id,
        title: `Episodio ${ep.number}`,
        season: 1,
        episode: ep.number,
        released: new Date(0).toISOString(),
      })),
    },
  };
}

const EMBED_EXTRACTORS: {
  name: string;
  pattern: RegExp;
  extract: (html: string, embedUrl: string) => Promise<string[]>;
}[] = [
  {
    name: "VOE",
    pattern: /voe\.sx/i,
    extract: async (html, embedUrl) => {
      // VOE redirects to lancewhosedifficult.com via JS — follow it
      const redirectM = html.match(/window\.location\.href\s*=\s*['"]([^'"]+lancewhosedifficult[^'"]+)['"]/i)
        || html.match(/window\.location\.href\s*=\s*['"]([^'"]+\/e\/[^'"]+)['"]/i);
      if (redirectM) {
        try {
          const redirectHtml = await fetchHtml(redirectM[1]);
          const m = redirectHtml.match(/'hls':\s*'([^']+)'/i)
            || redirectHtml.match(/hls:\s*["']([^"']+\.m3u8[^"']*)/i)
            || redirectHtml.match(/sources?\s*:\s*\[\s*{[^}]*file:\s*["']([^"']+)/i)
            || redirectHtml.match(/["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
          return m ? [m[1]] : [];
        } catch { return []; }
      }
      const m = html.match(/'hls':\s*'([^']+)'/i)
        || html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
      return m ? [m[1]] : [];
    },
  },
  {
    name: "Filemoon",
    pattern: /filemoon\.|moonplayer\./i,
    extract: async (html) => {
      // Try packed JS first
      const packed = html.match(/eval\(function\(p,a,c,k,e,(?:d|r)\)[\s\S]*?\)\)/);
      if (packed) {
        const unpacked = unpackJs(packed[0]);
        const m3u8 = unpacked.match(/https?:\/\/[^"'\s]+\.m3u8(?:[^"'\s]*)/);
        if (m3u8) return [m3u8[0]];
      }
      // Fallback: direct file reference
      const m = html.match(/file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i)
        || html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
      return m ? [m[1]] : [];
    },
  },
  {
    name: "Hexload",
    pattern: /hexload\.com/i,
    extract: async (html) => {
      const m = html.match(/file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i)
        || html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
      return m ? [m[1]] : [];
    },
  },
  {
    name: "DSVPlay",
    pattern: /dsvplay\.com/i,
    extract: async (html) => {
      const m = html.match(/file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i)
        || html.match(/source\s+src=["'](https?:\/\/[^"']+)/i)
        || html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
      return m ? [m[1]] : [];
    },
  },
  {
    name: "MXDrop",
    pattern: /mxdrop\.to/i,
    extract: async (html, embedUrl) => {
      // MXDrop also redirects via JS like VOE
      const redirectM = html.match(/window\.location\.href\s*=\s*['"]([^'"]+\/e\/[^'"]+)['"]/i);
      if (redirectM) {
        try {
          const redirectHtml = await fetchHtml(redirectM[1]);
          const m = redirectHtml.match(/file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i)
            || redirectHtml.match(/["'](https?:\/\/[^"']+\.m3u8[^"'\s]*)/i);
          return m ? [m[1]] : [];
        } catch { return []; }
      }
      const m = html.match(/file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i)
        || html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
      return m ? [m[1]] : [];
    },
  },
  {
    name: "Lulu",
    pattern: /luluvid\.com/i,
    extract: async (html) => {
      const m = html.match(/file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i)
        || html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
      return m ? [m[1]] : [];
    },
  },
  {
    name: "mp4upload",
    pattern: /mp4upload\.com/i,
    extract: async (html) => {
      const m = html.match(/src:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)/i)
        || html.match(/file:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)/i);
      return m ? [m[1]] : [];
    },
  },
  {
    name: "SaveFiles",
    pattern: /savefiles\.com/i,
    extract: async (html) => {
      const m = html.match(/file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i)
        || html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/i)
        || html.match(/src:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)/i);
      return m ? [m[1]] : [];
    },
  },
  {
    name: "VidGuard",
    pattern: /vidguard\.|vidhide\.|vgfplay\./i,
    extract: async (html) => {
      const m = html.match(/hls:\s*["']?(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
      return m ? [m[1]] : [];
    },
  },
  {
    name: "Dood",
    pattern: /dood\.|doodstream\./i,
    extract: async (html, embedUrl) => {
      const passM = html.match(/\/pass_md5\/[a-zA-Z0-9-]+\/([a-zA-Z0-9]+)/);
      if (!passM) return [];
      const base = new URL(embedUrl);
      const r = await fetch(`${base.protocol}//${base.host}${passM[0]}`, { headers: { Referer: embedUrl } });
      const text = await r.text();
      const tokenParam = html.match(/\?token=([a-zA-Z0-9]+)/)?.[1] || "";
      return [`${text}${tokenParam}&expiry=${Date.now() + 60000}`];
    },
  },
  {
    // Generic fallback — catches any host with an m3u8 or mp4 in the page
    name: "Generic",
    pattern: /.*/,
    extract: async (html) => {
      const m3u8s = [...html.matchAll(/["'](https?:\/\/[^"'\s]+\.m3u8(?:[^"'\s]*))["']/gi)].map(m => m[1]);
      if (m3u8s.length) return m3u8s;
      const mp4s = [...html.matchAll(/["'](https?:\/\/[^"'\s]+\.mp4(?:[^"'\s]*))["']/gi)].map(m => m[1]);
      return mp4s;
    },
  },
];

function unpackJs(packed: string): string {
  try {
    const match = packed.match(/\('([^']+)',(\d+),(\d+),'([^']+)'\.split\('\|'\)/);
    if (!match) {
      console.error("[unpackJs] Regex not matched:", packed.slice(0, 120));
      return "";
    }
    const [, p, , , kStr] = match;
    const a = parseInt(match[2]);
    const k = kStr.split("|");
    let result = p;
    for (let i = k.length - 1; i >= 0; i--) {
      if (k[i]) result = result.replace(new RegExp(`\\b${i.toString(a)}\\b`, "g"), k[i]);
    }
    return result;
  } catch (e) {
    console.error("[unpackJs] Exception:", e);
    return "";
  }
}

async function getStreams(rawId: string) {
  const parts = rawId.replace("latanime:", "").split(":");
  if (parts.length < 2) return { streams: [] };
  const slug = parts[0];
  const epNum = parts[1];

  const epUrl = `${BASE_URL}/ver/${slug}-episodio-${epNum}`;
  const html = await fetchHtml(epUrl);

  // Each <li id="play-video"><a class="play-video" data-player="BASE64_FULL_URL">name</a></li>
  // data-player is a base64-encoded FULL embed URL — no base key needed
  const embedUrls: { url: string; name: string }[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/<a[^>]+data-player="([A-Za-z0-9+/=]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const b64 = m[1];
    const rawName = m[2].replace(/<[^>]+>/g, "").trim() || "Player";
    if (seen.has(b64)) continue;
    seen.add(b64);

    let embedUrl = "";
    try { embedUrl = atob(b64); } catch { continue; }
    if (!embedUrl.startsWith("http")) embedUrl = embedUrl.startsWith("//") ? `https:${embedUrl}` : "";
    if (!embedUrl) continue;

    embedUrls.push({ url: embedUrl, name: rawName });
  }

  if (embedUrls.length === 0) {
    console.error(`[getStreams] 0 embeds found at ${epUrl}`);
    return { streams: [] };
  }

  const streams: { url: string; title: string; behaviorHints?: Record<string, unknown> }[] = [];

  // Run all extractors in parallel with a timeout
  const results = await Promise.allSettled(
    embedUrls.slice(0, 9).map(async (embed) => {
      const extractor = EMBED_EXTRACTORS.find((e) => e.pattern.test(embed.url));
      if (!extractor) return { embed, directUrls: [] as string[] };
      try {
        const embedHtml = await fetchHtml(embed.url);
        const urls = await extractor.extract(embedHtml, embed.url);
        return { embed, directUrls: urls.filter((u) => u?.startsWith("http")) };
      } catch {
        return { embed, directUrls: [] as string[] };
      }
    })
  );

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { embed, directUrls } = r.value;
    if (directUrls.length > 0) {
      for (const url of directUrls) {
        streams.push({ url, title: `▶ ${embed.name} — Latino`, behaviorHints: { notWebReady: false } });
      }
    } else {
      // Try Playwright bridge for JS-rendered hosts
      const bridgeUrl = await extractViaBridge(embed.url);
      if (bridgeUrl) {
        streams.push({ url: bridgeUrl, title: `▶ ${embed.name} — Latino`, behaviorHints: { notWebReady: false } });
      } else {
        streams.push({ url: embed.url, title: `🌐 ${embed.name} — Latino`, behaviorHints: { notWebReady: true } });
      }
    }
  }

  return { streams };
}

export default {
  async fetch(request: Request, env: Record<string, string>): Promise<Response> {
    // Read env vars per-request (Cloudflare Workers pattern)
    TMDB_KEY = env?.TMDB_API_KEY || "";
    BRIDGE_URL = env?.BRIDGE_URL || "";
    BRIDGE_KEY = env?.BRIDGE_API_KEY || "";

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (path === "/" || path === "/manifest.json") return json(MANIFEST);

    const catM = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/);
    if (catM) {
      const [, , catalogId, extraStr] = catM;
      const extra: Record<string, string> = {};
      if (extraStr) extraStr.split("&").forEach((p) => {
        const [k, v] = p.split("=");
        if (k && v) extra[k] = decodeURIComponent(v);
      });
      if (url.searchParams.get("search")) extra.search = url.searchParams.get("search")!;
      try { return json(await getCatalog(catalogId, extra)); }
      catch (e) { return json({ metas: [], error: String(e) }); }
    }

    const metaM = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
    if (metaM) {
      const id = decodeURIComponent(metaM[2]);
      const cached = cacheGet(`meta:${id}`);
      if (cached) return json(cached);
      try {
        const result = await getMeta(id);
        cacheSet(`meta:${id}`, result);
        return json(result);
      } catch (e) { return json({ meta: null, error: String(e) }); }
    }

    const streamM = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (streamM) {
      const id = decodeURIComponent(streamM[2]);
      const cached = cacheGet(`stream:${id}`);
      if (cached) return json(cached);
      try {
        const result = await getStreams(id);
        cacheSet(`stream:${id}`, result);
        return json(result);
      } catch (e) { return json({ streams: [], error: String(e) }); }
    }












    if (path === "/debug-bridge") {
      const testUrl = url.searchParams.get("url") || "https://voe.sx/e/nsjnujyoylgi";
      const bridgeResult = await extractViaBridge(testUrl);
      return json({
        BRIDGE_URL,
        BRIDGE_KEY: BRIDGE_KEY ? "set" : "not set",
        testUrl,
        result: bridgeResult,
      });
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
