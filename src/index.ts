/**
 * LATANIME STREMIO ADDON — v3.0
 * Cloudflare Worker + Browser Rendering API
 */

import puppeteer from "@cloudflare/puppeteer";

interface Env {
  BROWSER:   Fetcher;
  TMDB_KEY?: string;
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

const TTL = {
  catalog: 10 * 60 * 1000,
  meta:     2 * 60 * 60 * 1000,
  stream:  30 * 60 * 1000,
};

const MANIFEST = {
  id: ADDON_ID,
  version: "3.1.0",
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
      extra: [
        { name: "search",  isRequired: false },
        { name: "skip",    isRequired: false },
        { name: "genre",   isRequired: false },
      ],
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

async function fetchTmdb(animeName: string, tmdbKey: string): Promise<{
  poster: string; background: string; description: string; year: string;
} | null> {
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

  for (const m of html.matchAll(
    /href=["'](?:https?:\/\/latanime\.org)?\/anime\/([a-z0-9][a-z0-9-]+)["']/gi
  )) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);

    const pos   = m.index! + m[0].length;
    const block = html.slice(pos, pos + 600);

    const titleM =
      block.match(/<h3[^>]*>([^<]{3,})<\/h3>/i) ||
      block.match(/alt="([^"]{3,})"/) ||
      block.match(/title="([^"]{3,})"/);
    const name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : slug;
    if (!name || name.length < 2) continue;

    const posterM =
      block.match(/data-src="(https?:\/\/latanime\.org\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      block.match(/data-src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      block.match(/src="(https?:\/\/latanime\.org\/(?:thumbs|assets)\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/);
    const poster = posterM
      ? (posterM[1].startsWith("http") ? posterM[1] : `${BASE_URL}${posterM[1]}`)
      : "";

    results.push({ id: `latanime:${slug}`, name, poster });
  }

  return results.slice(0, 100);
}

function toMetaPreview(c: { id: string; name: string; poster: string }) {
  return {
    id: c.id,
    type: "series",
    name: c.name,
    poster: c.poster || `${BASE_URL}/public/img/anime.png`,
    posterShape: "poster",
  };
}

async function searchAnimes(query: string): Promise<{ id: string; name: string; poster: string }[]> {
  const homeHtml = await fetchHtml(`${BASE_URL}/`);
  const csrfM =
    homeHtml.match(/name="csrf-token"[^>]+content="([^"]+)"/i) ||
    homeHtml.match(/content="([^"]+)"[^>]+name="csrf-token"/i);
  const csrf = csrfM ? csrfM[1] : "";

  try {
    const r = await fetch(`${BASE_URL}/buscar_ajax`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": csrf,
        "X-Requested-With": "XMLHttpRequest",
        "Referer": `${BASE_URL}/`,
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

  const html = await fetchHtml(`${BASE_URL}/buscar?q=${encodeURIComponent(query)}`);
  return parseAnimeCards(html);
}

async function getCatalog(catalogId: string, extra: Record<string, string>) {
  const search = extra.search?.trim();
  if (search) {
    return { metas: (await searchAnimes(search)).map(toMetaPreview) };
  }
  if (catalogId === "latanime-airing") {
    return { metas: parseAnimeCards(await fetchHtml(`${BASE_URL}/emision`)).map(toMetaPreview) };
  }
  if (catalogId === "latanime-directory") {
    const skip  = parseInt(extra.skip || "0", 10);
    const page  = Math.floor(skip / 30) + 1;
    const genre = extra.genre || "";
    const params = new URLSearchParams({ page: String(page) });
    if (genre) params.set("genero", genre);
    const html = await fetchHtml(`${BASE_URL}/animes?${params}`);
    return { metas: parseAnimeCards(html).map(toMetaPreview) };
  }
  return { metas: parseAnimeCards(await fetchHtml(`${BASE_URL}/`)).map(toMetaPreview) };
}

async function getMeta(id: string, tmdbKey: string) {
  const slug = id.replace("latanime:", "");
  const html = await fetchHtml(`${BASE_URL}/anime/${slug}`);

  const titleM =
    html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) ||
    html.match(/<title>(.*?)\s*[—\-|].*?<\/title>/i);
  const name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : slug;

  const posterM =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) ||
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i) ||
    html.match(/src="(https?:\/\/latanime\.org\/thumbs\/imagen\/[^"]+)"/i);
  const poster = posterM ? posterM[1] : "";

  const descM =
    html.match(/<p[^>]*class="[^"]*opacity[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
    html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i) ||
    html.match(/<meta[^>]+content="([^"]+)"[^>]+name="description"/i);
  const description = descM ? descM[1].replace(/<[^>]+>/g, "").trim() : "";

  const genres: string[] = [];
  for (const gm of html.matchAll(/href="[^"]*\/genero\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const g = gm[1].replace(/<[^>]+>/g, "").trim();
    if (g) genres.push(g);
  }

  const episodes: { id: string; number: number }[] = [];
  const seenEps = new Set<string>();
  for (const em of html.matchAll(
    /href=["'](?:https?:\/\/latanime\.org)?\/ver\/([a-z0-9-]+-episodio-(\d+(?:\.\d+)?))["']/gi
  )) {
    if (seenEps.has(em[1])) continue;
    seenEps.add(em[1]);
    episodes.push({ id: `latanime:${slug}:${parseFloat(em[2])}`, number: parseFloat(em[2]) });
  }
  episodes.sort((a, b) => a.number - b.number);

  const tmdb = await fetchTmdb(name, tmdbKey);

  return {
    meta: {
      id,
      type: "series",
      name,
      poster:       tmdb?.poster      || poster,
      background:   tmdb?.background  || poster,
      description:  tmdb?.description || description,
      posterShape: "poster",
      releaseInfo:  tmdb?.year        || "",
      genres: genres.slice(0, 10),
      videos: episodes.map((ep) => ({
        id:       ep.id,
        title:    `Episodio ${ep.number}`,
        season:   1,
        episode:  ep.number,
        released: new Date(0).toISOString(),
      })),
    },
  };
}

async function extractStreamFromEmbed(embedUrl: string, env: Env): Promise<string | null> {
  let browser = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      "Referer": BASE_URL,
    });
    await page.setRequestInterception(true);

    let streamUrl: string | null = null;
    let resolveStream: (url: string) => void;
    const streamPromise = new Promise<string>((res) => { resolveStream = res; });

    page.on("request", (req: any) => {
      const u = req.url();

      if (!streamUrl && u.includes(".m3u8")) {
        streamUrl = u;
        resolveStream(u);
        req.abort();
        return;
      }

      if (!streamUrl && u.includes(".mp4") && !u.includes("analytics") && !u.includes("track")) {
        streamUrl = u;
        resolveStream(u);
        req.abort();
        return;
      }

      const blocked = ["googlesyndication", "doubleclick", "facebook.com/tr",
                       "analytics", "adserver", "popads", "adnxs"];
      if (blocked.some((b) => u.includes(b))) { req.abort(); return; }

      const rt = req.resourceType();
      if (["image", "font", "media"].includes(rt)) { req.abort(); return; }

      req.continue();
    });

    await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

    const result = await Promise.race([
      streamPromise,
      new Promise<null>((res) => setTimeout(() => res(null), 12000)),
    ]);

    return result;

  } catch (e) {
    console.error(`[extractStream] ${embedUrl} →`, String(e));
    return null;
  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }
}

async function getStreams(rawId: string, env: Env) {
  const parts = rawId.replace("latanime:", "").split(":");
  if (parts.length < 2) return { streams: [] };
  const slug  = parts[0];
  const epNum = parts[1];

  const epUrl = `${BASE_URL}/ver/${slug}-episodio-${epNum}`;
  const html  = await fetchHtml(epUrl);

  const embedUrls: { url: string; name: string }[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(
    /<a[^>]+data-player="([A-Za-z0-9+/=]+)"[^>]*>([\s\S]*?)<\/a>/gi
  )) {
    const b64     = m[1];
    const rawName = m[2].replace(/<[^>]+>/g, "").trim() || "Player";
    if (seen.has(b64)) continue;
    seen.add(b64);

    let embedUrl = "";
    try { embedUrl = atob(b64); } catch { continue; }
    if (embedUrl.startsWith("//")) embedUrl = `https:${embedUrl}`;
    if (!embedUrl.startsWith("http")) continue;

    embedUrls.push({ url: embedUrl, name: rawName });
  }

  if (embedUrls.length === 0) {
    console.error(`[getStreams] 0 embeds at ${epUrl}`);
    return { streams: [] };
  }

  const settled = await Promise.allSettled(
    embedUrls.slice(0, 4).map(async (embed) => {
      const streamUrl = await extractStreamFromEmbed(embed.url, env);
      return streamUrl ? { url: streamUrl, name: embed.name } : null;
    })
  );

  const streams: { url: string; title: string; behaviorHints: { notWebReady: boolean } }[] = [];

  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) {
      streams.push({
        url:   r.value.url,
        title: `🌎 ${r.value.name} — Latino`,
        behaviorHints: { notWebReady: false },
      });
    }
  }

  return { streams };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url  = new URL(request.url);
    const path = url.pathname;
    const tmdbKey = env.TMDB_KEY || "";

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

      const cacheKey = `catalog:${catalogId}:${extra.search || ""}`;
      const cached = cacheGet(cacheKey);
      if (cached) return json(cached);
      try {
        const result = await getCatalog(catalogId, extra);
        cacheSet(cacheKey, result, TTL.catalog);
        return json(result);
      } catch (e) { return json({ metas: [], error: String(e) }); }
    }

    const metaM = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
    if (metaM) {
      const id = decodeURIComponent(metaM[2]);
      const cached = cacheGet(`meta:${id}`);
      if (cached) return json(cached);
      try {
        const result = await getMeta(id, tmdbKey);
        cacheSet(`meta:${id}`, result, TTL.meta);
        return json(result);
      } catch (e) { return json({ meta: null, error: String(e) }); }
    }

    const streamM = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (streamM) {
      const id = decodeURIComponent(streamM[2]);
      const cached = cacheGet(`stream:${id}`);
      if (cached) return json(cached);
      try {
        const result = await getStreams(id, env);
        if ((result.streams as unknown[]).length > 0) {
          cacheSet(`stream:${id}`, result, TTL.stream);
        }
        return json(result);
      } catch (e) { return json({ streams: [], error: String(e) }); }
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
