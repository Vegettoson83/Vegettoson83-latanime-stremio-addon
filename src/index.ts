
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

const TTL = {
  catalog:  10 * 60,
  meta:      2 * 60 * 60,
  stream:   30 * 60,
};

async function cacheGet(key: string, kv: KVNamespace | undefined): Promise<unknown> {
  if (!kv) return null;
  try {
    const val = await kv.get(key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

async function cacheSet(key: string, data: unknown, ttlSec: number, kv: KVNamespace | undefined) {
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(data), { expirationTtl: ttlSec });
  } catch (e) {
    console.log(`[cache] KV write failed for ${key}: ${e}`);
  }
}

const MANIFEST = {
  id: ADDON_ID,
  version: "4.5.0",
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
};

async function fetchHtml(url: string, env?: Env): Promise<string> {
  const encoded = encodeURIComponent(url);
  const bridgeUrl = env?.BRIDGE_URL?.trim();
  const controller = new AbortController();
  const globalTimer = setTimeout(() => controller.abort(), 25000);

  const tryFetch = async (name: string, fetcher: () => Promise<Response>): Promise<string> => {
    if (controller.signal.aborted) throw new Error(`${name}: global timeout`);
    const r = await fetcher();
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    const html = await r.text();
    if (html.length < 500) throw new Error(`${name}: too short (${html.length}b)`);
    return html;
  };

  try {
    const phase1: Promise<string>[] = [
      tryFetch("direct", () => fetch(url, { headers: CHROME_HEADERS, signal: AbortSignal.timeout(8000) })),
    ];
    if (bridgeUrl) {
      phase1.push(tryFetch("bridge", () => fetch(`${bridgeUrl}/fetch?url=${encoded}`, { signal: AbortSignal.timeout(12000) })));
    }
    try {
      const result = await Promise.any(phase1);
      clearTimeout(globalTimer);
      return result;
    } catch { }

    for (const [name, proxyUrl] of [
      ["allorigins", `https://api.allorigins.win/raw?url=${encoded}`],
      ["codetabs",   `https://api.codetabs.com/v1/proxy?quest=${encoded}`],
      ["corsproxy",  `https://corsproxy.io/?${encoded}`],
    ] as [string, string][]) {
      if (controller.signal.aborted) break;
      try {
        const html = await tryFetch(name, () => fetch(proxyUrl, { headers: { "User-Agent": CHROME_UA }, signal: AbortSignal.timeout(8000) }));
        clearTimeout(globalTimer);
        return html;
      } catch { }
    }
    throw new Error(`All proxies failed for ${url}`);
  } finally {
    clearTimeout(globalTimer);
  }
}

async function fetchTmdb(animeName: string, tmdbKey: string) {
  if (!tmdbKey) return null;
  const cleanName = animeName
    .replace(/\s+(Latino|Castellano|Japones|Japonés|Sub\s+Español)$/i, "")
    .replace(/\s+S(\d+)$/i, " Season $1")
    .trim();
  try {
    const r = await fetch(`${TMDB_BASE}/search/tv?api_key=${tmdbKey}&query=${encodeURIComponent(cleanName)}&language=es-ES`);
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
  for (const m of html.matchAll(/href=["'](?:https?:\/\/latanime\.org)?\/anime\/([a-z0-9][a-z0-9-]+)["']/gi)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const pos = m.index! + m[0].length;
    const block = html.slice(pos, pos + 600);
    const titleM = block.match(/<h3[^>]*>([^<]{3,})<\/h3>/i) || block.match(/alt="([^"]{3,})"/) || block.match(/title="([^"]{3,})"/);
    let name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : slug;

    // Categorization logic
    const labels: string[] = [];
    if (block.includes("Latino") || name.includes("Latino")) labels.push("Latino");
    if (block.includes("Castellano") || name.includes("Castellano")) labels.push("Castellano");
    if (block.includes("Pelicula") || block.includes("Película") || name.toLowerCase().includes("pelicula")) labels.push("Pelicula");

    if (labels.length > 0) {
      name = `${name} (${labels.join("/")})`;
    }

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

async function searchAnimes(query: string, env?: Env) {
  const homeHtml = await fetchHtml(`${BASE_URL}/`, env);
  const csrfM = homeHtml.match(/name="csrf-token"[^>]+content="([^"]+)"/i) || homeHtml.match(/content="([^"]+)"[^>]+name="csrf-token"/i);
  const csrf = csrfM ? csrfM[1] : "";
  try {
    const r = await fetch(`${BASE_URL}/buscar_ajax`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrf, "X-Requested-With": "XMLHttpRequest", "Referer": `${BASE_URL}/`, "Origin": BASE_URL, "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify({ q: query }),
    });
    if (r.ok) {
      const html = await r.text();
      const results = parseAnimeCards(html);
      if (results.length > 0) return results;
    }
  } catch { }
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
  const posterM = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
  const poster = posterM ? posterM[1] : "";
  const descM = html.match(/<p[^>]*class="[^"]*opacity[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
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

// ─── EXTRACTORS ─────────────────────────────────────────────────────────────

async function resolveMediafire(mfUrl: string): Promise<string | null> {
  try {
    const r = await fetch(mfUrl, { headers: { "User-Agent": CHROME_UA, "Referer": "https://www.mediafire.com/" } });
    if (!r.ok) return null;
    const html = await r.text();
    const match = html.match(/https:\/\/download\d+\.mediafire\.com[^"'\s]+/);
    if (match) return match[0];
    const btnMatch = html.match(/aria-label="Download file"[^>]+href="([^"]+)"|href="([^"]+)"[^>]*id="downloadButton"/);
    return btnMatch ? (btnMatch[1] || btnMatch[2]) : null;
  } catch { return null; }
}

async function extractSavefiles(embedUrl: string) {
  try {
    const fileCode = embedUrl.match(/savefiles\.com\/(?:e\/)?([a-z0-9]+)/i)?.[1] || embedUrl.match(/streamhls\.to\/e\/([a-z0-9]+)/i)?.[1];
    if (!fileCode) return null;
    const r = await fetch(`https://streamhls.to/dl`, {
      method: "POST",
      headers: { "User-Agent": CHROME_UA, "Referer": `https://streamhls.to/e/${fileCode}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: `op=embed&file_code=${fileCode}&auto=1&referer=https://savefiles.com/${fileCode}`,
    });
    const html = await r.text();
    const m = html.match(/sources:\s*\["([^"]+\.m3u8[^"]*)"\]/) || html.match(/https:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/);
    return m ? (Array.isArray(m) ? m[1] || m[0] : m) : null;
  } catch { return null; }
}

function extractMega(url: string): string {
  return url.replace("/file/", "/embed/");
}

async function extractGofile(url: string, workerBase: string): Promise<string | null> {
  try {
    const folderId = url.split("/d/").pop()?.split(/[/?]/)[0];
    if (!folderId) return null;
    const accR = await fetch("https://api.gofile.io/accounts", { method: "POST" });
    const accData: any = await accR.json();
    const token = accData.data?.token;
    if (!token) return null;
    const r = await fetch(`https://api.gofile.io/contents/${folderId}?wt=4fd6sg89d7s6`, {
      headers: { "Authorization": `Bearer ${token}`, "X-Website-Token": "4fd6sg89d7s6" }
    });
    const data: any = await r.json();
    const file = data.data?.children && Object.values(data.data.children).find((c: any) => c.type === "file");
    if (file?.directLink) {
      const finalUrl = `${workerBase}/proxy/file?url=${encodeURIComponent(file.directLink)}&token=${token}`;
      return finalUrl;
    }
    return null;
  } catch { return null; }
}

async function extractViaBridge(embedUrl: string, bridgeUrl: string) {
  try {
    const r = await fetch(`${bridgeUrl}/extract?url=${encodeURIComponent(embedUrl)}`, { signal: AbortSignal.timeout(50000) });
    const data: any = await r.json();
    return data.url || null;
  } catch { return null; }
}

async function getStreams(rawId: string, env: Env, request: Request) {
  const parts = rawId.replace("latanime:", "").split(":");
  if (parts.length < 2) return { streams: [] };
  const [slug, epNum] = parts;
  const html = await fetchHtml(`${BASE_URL}/ver/${slug}-episodio-${epNum}`, env);

  const embedUrls: { url: string; name: string }[] = [];
  const seen = new Set<string>();
  const keyM = html.match(/data-key="([A-Za-z0-9+/=]+)"/);
  const baseUrlPrefix = keyM ? (() => { try { return atob(keyM[1]); } catch { return ""; } })() : "";

  for (const m of html.matchAll(/<a[^+]+data-player="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const suffix = m[1].trim();
    const name = m[2].replace(/<[^>]+>/g, "").trim() || "Player";
    if (seen.has(suffix)) continue;
    seen.add(suffix);
    let embedUrl = name.toLowerCase().includes("yourupload") ? (() => { try { return atob(suffix); } catch { return ""; } })() : baseUrlPrefix + suffix;
    if (embedUrl.startsWith("//")) embedUrl = `https:${embedUrl}`;
    if (embedUrl.startsWith("http")) embedUrls.push({ url: embedUrl, name });
  }

  const mirrors: any = {};
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = m[1].trim();
    if (href.includes("mediafire.com/file/")) mirrors.mediafire = href;
    else if (href.includes("mega.nz/file/")) mirrors.mega = href;
    else if (href.includes("gofile.io/d/")) mirrors.gofile = href;
    else if (href.includes("pixeldrain.com/u/")) mirrors.pixeldrain = href;
    else if (href.includes("savefiles.com/") && !href.includes("/d/")) mirrors.savefiles = href;
  }

  const bridgeUrl = (env.BRIDGE_URL || "").trim();
  const workerBase = new URL(request.url).origin;
  const streams: any[] = [];

  const tasks: (() => Promise<any>)[] = [];

  if (mirrors.mediafire) tasks.push(async () => {
    const url = await resolveMediafire(mirrors.mediafire);
    return url ? { url, title: "▶ MediaFire MP4 — Latino", priority: 1 } : null;
  });
  if (mirrors.mega) tasks.push(async () => ({ url: extractMega(mirrors.mega), title: "▶ Mega.nz — Latino", priority: 1 }));
  if (mirrors.gofile) tasks.push(async () => {
    const url = await extractGofile(mirrors.gofile, workerBase);
    return url ? { url, title: "▶ Gofile — Latino", priority: 1 } : null;
  });
  if (mirrors.pixeldrain) tasks.push(async () => {
    const id = mirrors.pixeldrain.match(/u\/([a-zA-Z0-9]+)/)?.[1];
    return id ? { url: `https://pixeldrain.com/api/file/${id}`, title: "▶ Pixeldrain — Latino", priority: 1 } : null;
  });

  embedUrls.forEach(embed => {
    tasks.push(async () => {
      if (embed.url.includes("pixeldrain.com")) {
        const id = embed.url.match(/u\/([a-zA-Z0-9]+)/)?.[1];
        return id ? { url: `https://pixeldrain.com/api/file/${id}`, title: `▶ ${embed.name} — Latino` } : null;
      }
      if (embed.url.includes("savefiles.com") || embed.url.includes("streamhls.to")) {
        const url = await extractSavefiles(embed.url);
        return url ? { url, title: `▶ ${embed.name} — Latino`, isHls: true, ref: "https://streamhls.to/" } : null;
      }
      if (bridgeUrl) {
        const url = await extractViaBridge(embed.url, bridgeUrl);
        return url ? { url, title: `▶ ${embed.name} — Latino`, isHls: url.includes(".m3u8") } : null;
      }
      return { url: embed.url, title: `🌐 ${embed.name} — Latino`, external: true };
    });
  });

  // Batch parallel execution (limit 5)
  for (let i = 0; i < tasks.length; i += 5) {
    const batch = tasks.slice(i, i + 5);
    const results = await Promise.all(batch.map(t => t()));
    results.forEach(r => {
      if (!r) return;
      const stream: any = { url: r.url, title: r.title };
      if (r.isHls) {
        const ref = r.ref || "https://latanime.org/";
        stream.url = `${workerBase}/proxy/m3u8?url=${encodeURIComponent(r.url)}&ref=${encodeURIComponent(ref)}`;
        stream.behaviorHints = { notWebReady: true };
      } else if (r.external) {
        stream.behaviorHints = { notWebReady: true };
      }
      if (r.priority) streams.unshift(stream); else streams.push(stream);
    });
  }

  return { streams };
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const tmdbKey = (env.TMDB_KEY || "").trim();

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (path === "/" || path === "/manifest.json") return json(MANIFEST);
    if (path === "/_health") return json({ status: "alive", kv: env.STREAM_CACHE ? "bound" : "missing" });

    const { "Content-Type": _ct, ...corsNoCt } = CORS;

    if (path === "/proxy/file") {
      const targetUrl = url.searchParams.get("url");
      const token = url.searchParams.get("token");
      if (!targetUrl || !new URL(targetUrl).hostname.endsWith(".gofile.io")) return new Response("Forbidden", { status: 403 });
      const headers: any = { "User-Agent": CHROME_UA };
      if (token) headers["Cookie"] = `accountToken=${token}`;
      const range = request.headers.get("Range");
      if (range) headers["Range"] = range;
      const r = await fetch(targetUrl, { headers });
      const resp = new Response(r.body, { status: r.status, headers: { ...corsNoCt, "Content-Type": r.headers.get("Content-Type") || "video/mp4", "Accept-Ranges": "bytes", "Content-Length": r.headers.get("Content-Length") || "" } });
      if (r.headers.get("Content-Range")) resp.headers.set("Content-Range", r.headers.get("Content-Range")!);
      return resp;
    }

    if (path === "/proxy/m3u8") {
      const m3u8Url = url.searchParams.get("url");
      const referer = url.searchParams.get("ref") || "https://latanime.org/";
      if (!m3u8Url) return new Response("Missing url", { status: 400 });
      const decoded = decodeURIComponent(m3u8Url);
      const base = decoded.substring(0, decoded.lastIndexOf("/") + 1);
      const workerBase = new URL(request.url).origin;
      const r = await fetch(decoded, { headers: { "Referer": referer, "User-Agent": CHROME_UA } });
      if (!r.ok) return new Response("Upstream error", { status: r.status });
      const m3u8Text = await r.text();
      const rewritten = m3u8Text.split("\n").map(line => {
        if (line.startsWith("#") || line.trim() === "") return line;
        const absUrl = line.startsWith("http") ? line : base + line;
        return absUrl.includes(".m3u8")
          ? `${workerBase}/proxy/m3u8?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer)}`
          : `${workerBase}/proxy/seg?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer)}`;
      }).join("\n");
      return new Response(rewritten, { headers: { "Content-Type": "application/vnd.apple.mpegurl", ...corsNoCt } });
    }

    if (path === "/proxy/seg") {
      const segUrl = url.searchParams.get("url");
      const referer = url.searchParams.get("ref") || "https://latanime.org/";
      if (!segUrl) return new Response("Missing url", { status: 400 });
      const r = await fetch(decodeURIComponent(segUrl), { headers: { "Referer": referer, "User-Agent": CHROME_UA } });
      return new Response(r.body, { status: r.status, headers: { "Content-Type": r.headers.get("Content-Type") || "video/MP2T", ...corsNoCt, "Cache-Control": "public, max-age=3600" } });
    }

    const catM = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/);
    if (catM) {
      const [, , catalogId, extraStr] = catM;
      const extra: Record<string, string> = {};
      if (extraStr) extraStr.split("&").forEach(p => { const [k, v] = p.split("="); if (k && v) extra[k] = decodeURIComponent(v); });
      const cacheKey = `cat:${catalogId}:${extra.search || extra.skip || ""}`;
      const cached = await cacheGet(cacheKey, env.STREAM_CACHE);
      if (cached) return json(cached);
      const result = await getCatalog(catalogId, extra, env);
      await cacheSet(cacheKey, result, TTL.catalog, env.STREAM_CACHE);
      return json(result);
    }

    const metaM = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
    if (metaM) {
      const id = decodeURIComponent(metaM[2]);
      const cached = await cacheGet(`meta:${id}`, env.STREAM_CACHE);
      if (cached) return json(cached);
      const result = await getMeta(id, tmdbKey, env);
      await cacheSet(`meta:${id}`, result, TTL.meta, env.STREAM_CACHE);
      return json(result);
    }

    const streamM = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (streamM) {
      const id = decodeURIComponent(streamM[2]);
      const cached = await cacheGet(`stream:${id}`, env.STREAM_CACHE);
      if (cached) return json(cached);
      const result = await getStreams(id, env, request);
      if (result.streams.length > 0) await cacheSet(`stream:${id}`, result, TTL.stream, env.STREAM_CACHE);
      return json(result);
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
