
const ADDON_ID = "com.latanime.stremio";
const BASE_URL = "https://latanime.org";

// /animes filter values scraped from the site's filter form. Keys are the
// display names Stremio sends back via the "genre" extra; values are the
// query fragment for /animes. categoria=Película must keep the accent —
// the site ignores the unaccented slug.
const DIR_FILTERS: Record<string, string> = {
  "Latino": "categoria=latino",
  "Castellano": "categoria=castellano",
  "Película": "categoria=Pel%C3%ADcula",
  "OVA": "categoria=ova",
  "ONA": "categoria=ona",
  "Especial": "categoria=especial",
  "Donghua": "categoria=donghua",
  "Live Action": "categoria=live-action",
  "Acción": "genero=accion",
  "Aventura": "genero=aventura",
  "Artes Marciales": "genero=artes-marciales",
  "Carreras": "genero=carreras",
  "Ciencia Ficción": "genero=ciencia-ficcion",
  "Comedia": "genero=comedia",
  "Cyberpunk": "genero=cyberpunk",
  "Demonios": "genero=demonios",
  "Deportes": "genero=deportes",
  "Drama": "genero=drama",
  "Ecchi": "genero=ecchi",
  "Escolares": "genero=escolares",
  "Espacial": "genero=espacial",
  "Fantasía": "genero=fantasia",
  "Gore": "genero=gore",
  "Harem": "genero=harem",
  "Histórico": "genero=historico",
  "Horror": "genero=horror",
  "Isekai": "genero=isekai",
  "Josei": "genero=josei",
  "Lucha": "genero=lucha",
  "Magia": "genero=magia",
  "Mecha": "genero=mecha",
  "Militar": "genero=militar",
  "Misterio": "genero=misterio",
  "Monogatari": "genero=monogatari",
  "Música": "genero=musica",
  "Parodias": "genero=parodias",
  "Policía": "genero=policia",
  "Psicológico": "genero=psicologico",
  "Recuerdos de la vida": "genero=recuerdos-de-la-vida",
  "Romance": "genero=romance",
  "Samurai": "genero=samurai",
  "Seinen": "genero=seinen",
  "Shojo": "genero=shojo",
  "Shonen": "genero=shonen",
  "Sobrenatural": "genero=sobrenatural",
  "Suspenso": "genero=suspenso",
  "Vampiros": "genero=vampiros",
  "Yaoi": "genero=yaoi",
  "Yuri": "genero=yuri",
};
for (let y = new Date().getFullYear(); y >= 2000; y--) DIR_FILTERS[String(y)] = `fecha=${y}`;
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
  MFP_URL: string;
  MFP_PASSWORD: string;
  // Non-Cloudflare HTML fetch proxy (deno/fetch.ts on Deno Deploy).
  // latanime.org blocks Worker egress; this relays its HTML from Deno's edge.
  FETCH_PROXY_URL: string;
  // Optional Cloudflare Browser Rendering (REST API). When both are set,
  // hosts that need a real browser (JS challenges, SPA players, JS-built
  // download links) are rendered on Cloudflare's edge. Unset = manual only.
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

// ─── CACHE — KV only, no in-memory Map ───────────────────────────────────────
// The in-memory Map was the memory leak causing 1101 crashes.
// Worker isolates share nothing between requests — the Map grew unbounded
// until the isolate hit 128MB and Cloudflare killed it mid-request.
// KV has no size limit and survives isolate restarts.

const TTL = {
  catalog:  10 * 60,        // 10 min (seconds for KV)
  meta:      2 * 60 * 60,   // 2 hr
  stream:   30 * 60,        // 30 min
  render:    15 * 60,       // 15 min — a resolved browser-render result (signed
                            // URLs expire, so keep it under typical token life)
  renderMiss: 5 * 60,       // 5 min — retry a host that failed to render sooner
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
  version: "4.9.2",
  name: "Latanime",
  description: "Anime Latino y Castellano desde latanime.org",
  logo: "https://latanime.org/img/logito.png",
  resources: ["catalog", "meta", "stream"],
  types: ["series"],
  catalogs: [
    { type: "series", id: "latanime-latest", name: "Latanime — Recientes", extra: [{ name: "search", isRequired: false }] },
    { type: "series", id: "latanime-airing", name: "Latanime — En Emisión", extra: [] },
    { type: "series", id: "latanime-directory", name: "Latanime — Directorio", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }, { name: "genre", isRequired: false, options: Object.keys(DIR_FILTERS) }] },
    { type: "series", id: "latanime-peliculas", name: "Latanime — Películas", extra: [{ name: "skip", isRequired: false }] },
  ],
  idPrefixes: ["latanime:"],
};

// ─── PROXY LOAD BALANCER ──────────────────────────────────────────────────────

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

async function fetchHtml(url: string, env?: Env): Promise<string> {
  const encoded = encodeURIComponent(url);

  // Hard 25s budget — Worker wall time limit is 30s
  const controller = new AbortController();
  const globalTimer = setTimeout(() => controller.abort(), 25000);

  const tryFetch = async (name: string, fetcher: () => Promise<Response>): Promise<string> => {
    if (controller.signal.aborted) throw new Error(`${name}: global timeout`);
    const r = await fetcher();
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    const html = await r.text();
    if (html.length < 500) throw new Error(`${name}: too short (${html.length}b)`);
    if (name !== "direct") console.log(`[fetchHtml] ${name} for ${url}`);
    return html;
  };

  try {
    // Phase 1: race direct fetch against the non-Cloudflare Deno Deploy proxy
    // (deno/fetch.ts) and take whichever returns valid HTML first. latanime.org
    // blocks Worker egress, so the direct leg almost always rejects fast while
    // the proxy wins in ~2-3s — racing avoids burning ~8s on the doomed direct
    // attempt before falling back (that lag was starving /stream and making
    // catalog rows time out in Stremio). The proxy allowlists latanime.org only.
    const proxyBase = env?.FETCH_PROXY_URL?.trim();
    const racers: Promise<string>[] = [
      tryFetch("direct", () => fetch(url, { headers: CHROME_HEADERS, signal: AbortSignal.timeout(8000) })),
    ];
    if (proxyBase) {
      racers.push(tryFetch("fetchproxy", () =>
        fetch(`${proxyBase}?url=${encoded}`, { headers: { "User-Agent": CHROME_UA }, signal: AbortSignal.timeout(12000) })
      ));
    }
    try {
      const html = await Promise.any(racers);
      clearTimeout(globalTimer);
      return html;
    } catch { /* every racer rejected — fall through */ }

    // Phase 2: Cloudflare Browser Rendering — a real edge browser that clears
    // the Cloudflare challenge reliably. Only fires when configured; latanime
    // pages are server-rendered so "load" is enough (no JS wait needed).
    if (env && browserRenderingReady(env) && !controller.signal.aborted) {
      const html = await renderPage(url, env, { wait: "load", timeoutMs: 16000 });
      if (html && html.length >= 500) {
        clearTimeout(globalTimer);
        console.log(`[fetchHtml] render for ${url}`);
        return html;
      }
    }

    // Phase 3: free CORS proxies (last resort; frequently down)
    for (const [name, proxyUrl] of [
      ["allorigins", `https://api.allorigins.win/raw?url=${encoded}`],
      ["codetabs",   `https://api.codetabs.com/v1/proxy?quest=${encoded}`],
      ["corsproxy",  `https://corsproxy.io/?${encoded}`],
    ] as [string, string][]) {
      if (controller.signal.aborted) break;
      try {
        const html = await tryFetch(name, () =>
          fetch(proxyUrl, { headers: { "User-Agent": CHROME_UA }, signal: AbortSignal.timeout(8000) })
        );
        clearTimeout(globalTimer);
        return html;
      } catch (e) {
        console.log(`[fetchHtml] ${name} failed: ${e}`);
      }
    }

    throw new Error(`All fetch strategies failed for ${url}`);
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
    const r = await fetch(
      `${TMDB_BASE}/search/tv?api_key=${tmdbKey}&query=${encodeURIComponent(cleanName)}&language=es-ES`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) }
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
  for (const m of html.matchAll(/href=["'](?:https?:\/\/latanime\.org)?\/anime\/([a-z0-9][a-z0-9-]+)["']/gi)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const pos = m.index! + m[0].length;
    const block = html.slice(pos, pos + 600);
    const titleM = block.match(/<h3[^>]*>([^<]{3,})<\/h3>/i) || block.match(/alt="([^"]{3,})"/) || block.match(/title="([^"]{3,})"/);
    const name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : slug;
    if (!name || name.length < 2) continue;
    const posterM =
      block.match(/data-src="(https?:\/\/latanime\.org\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      block.match(/data-src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      block.match(/src="(https?:\/\/latanime\.org\/(?:thumbs|assets)\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/);
    const poster = posterM
      ? posterM[1].startsWith("http") ? posterM[1] : `${BASE_URL}${posterM[1]}`
      : "";
    results.push({ id: `latanime:${slug}`, name, poster });
  }
  return results.slice(0, 100);
}

// The home page's "Recientes" section links to /ver/{slug}-episodio-N episode
// pages, not /anime/{slug} — so recent shows never surface via parseAnimeCards.
// Derive the anime slug from the episode URL and the title from the card's alt
// text ("TITLE capitulo N").
function parseEpisodeCards(html: string) {
  const results: { id: string; name: string; poster: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href=["'](?:https?:\/\/latanime\.org)?\/ver\/([a-z0-9-]+)-episodio-[\d.]+["']/gi)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const pos = m.index! + m[0].length;
    const block = html.slice(pos, pos + 600);
    const altM = block.match(/alt="([^"]{3,})"/);
    const name = altM ? altM[1].replace(/\s+cap[ií]tulo\s+[\d.]+\s*$/i, "").trim() : slug;
    const posterM =
      block.match(/data-src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      block.match(/src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/);
    let poster = posterM ? posterM[1] : "";
    if (poster && !poster.startsWith("http")) poster = `${BASE_URL}${poster}`;
    if (poster.includes("capblank")) poster = ""; // lazyload placeholder
    results.push({ id: `latanime:${slug}`, name, poster });
  }
  return results;
}

function toMetaPreview(c: { id: string; name: string; poster: string }) {
  return { id: c.id, type: "series", name: c.name, poster: c.poster || `${BASE_URL}/img/anime.png`, posterShape: "poster" };
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
      signal: AbortSignal.timeout(8000),
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
  const page = Math.floor(parseInt(extra.skip || "0", 10) / 30) + 1;
  if (catalogId === "latanime-peliculas") {
    return { metas: parseAnimeCards(await fetchHtml(`${BASE_URL}/animes?${DIR_FILTERS["Película"]}&page=${page}`, env)).map(toMetaPreview) };
  }
  if (catalogId === "latanime-directory") {
    const filter = extra.genre && DIR_FILTERS[extra.genre] ? `${DIR_FILTERS[extra.genre]}&` : "";
    return { metas: parseAnimeCards(await fetchHtml(`${BASE_URL}/animes?${filter}page=${page}`, env)).map(toMetaPreview) };
  }
  // latanime-latest: true recents come from the episode cards; append the
  // rest of the home page's anime cards (popular/seasonal sections) after
  const home = await fetchHtml(`${BASE_URL}/`, env);
  const recent = parseEpisodeCards(home);
  const seenIds = new Set(recent.map((c) => c.id));
  const rest = parseAnimeCards(home).filter((c) => !seenIds.has(c.id));
  return { metas: [...recent, ...rest].slice(0, 100).map(toMetaPreview) };
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
      // no released date — latanime doesn't expose one, and a fake epoch
      // renders as "1969"/"1970" in the apps
      videos: episodes.map((ep) => ({ id: ep.id, title: `Episodio ${ep.number}`, season: 1, episode: ep.number })),
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
      signal: AbortSignal.timeout(8000),
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
      signal: AbortSignal.timeout(10000),
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
      signal: AbortSignal.timeout(12000),
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


// ─── DEAN EDWARDS p.a.c.k.e.r UNPACKER ─────────────────────────────────────
// Many embed hosts ship their player config inside an
// `eval(function(p,a,c,k,e,d){…})` block. Reversing it here — pure string
// work, no browser — recovers the plaintext the browser would have run,
// which is where the real media URL lives.
function unpackPacker(source: string): string | null {
  const m = source.match(/}\s*\(\s*'(.*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'(.*?)'\.split\('\|'\)/s);
  if (!m) return null;
  const base = parseInt(m[2], 10);
  const count = parseInt(m[3], 10);
  const words = m[4].split("|");
  const payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  const encode = (n: number): string =>
    (n < base ? "" : encode(Math.floor(n / base))) +
    ((n = n % base) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  const dict: Record<string, string> = {};
  for (let i = count - 1; i >= 0; i--) {
    const k = encode(i);
    dict[k] = words[i] || k;
  }
  return payload.replace(/\b\w+\b/g, (w) => dict[w] || w);
}

// MixDrop (and its rotating mirror domains — mixdrop.*, miixdrop.net) packs
// MDCore.wurl inside a p.a.c.k.e.r block. The recovered URL is a direct,
// seekable MP4 the Stremio client can fetch itself — no referer, no proxy.
async function extractMixdrop(embedUrl: string): Promise<string | null> {
  try {
    const r = await fetch(embedUrl, {
      headers: { "User-Agent": CHROME_UA, "Referer": "https://latanime.org/" },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const unpacked = unpackPacker(await r.text());
    if (!unpacked) return null;
    const m = unpacked.match(/MDCore\.wurl\s*=\s*"([^"]+)"/);
    if (!m) return null;
    return m[1].startsWith("//") ? `https:${m[1]}` : m[1];
  } catch { return null; }
}


// ─── CLOUDFLARE BROWSER RENDERING (optional) ───────────────────────────────
// Renders a page with a real browser on Cloudflare's edge via the REST API —
// no `@cloudflare/puppeteer` import (that import was the root cause of the
// old 1101 crashes). Passes JS challenges (DDoS-Guard), SPA hydration and
// JS-built links that plain fetch can't, and runs from Cloudflare's browser
// pool rather than blocked Worker egress. No-ops unless both env vars are set.
// `wait` is "load" for server-rendered pages (fast) and "networkidle0" for
// player embeds whose media URL only exists after JS runs.
function browserRenderingReady(env: Env): boolean {
  return !!(env.CF_ACCOUNT_ID || "").trim() && !!(env.CF_API_TOKEN || "").trim();
}

async function renderPage(url: string, env: Env, opts: { referer?: string; wait?: "load" | "domcontentloaded" | "networkidle0"; timeoutMs?: number } = {}): Promise<string | null> {
  const acct = (env.CF_ACCOUNT_ID || "").trim();
  const token = (env.CF_API_TOKEN || "").trim();
  if (!acct || !token) return null;
  const timeoutMs = opts.timeoutMs ?? 20000;
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/browser-rendering/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        url,
        setExtraHTTPHeaders: { Referer: opts.referer ?? "https://latanime.org/" },
        gotoOptions: { waitUntil: opts.wait ?? "networkidle0", timeout: Math.max(6000, timeoutMs - 3000) },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const data: any = await r.json();
    // REST envelope: { success, result: "<html>" } (result may also be an object)
    const html = typeof data?.result === "string" ? data.result : (data?.result?.html || "");
    return html && html.length > 200 ? html : null;
  } catch { return null; }
}

// VOE hides its real source in a <script type="application/json"> blob that a
// multi-step obfuscation encodes. Reversing it (rot13 → strip pattern chars →
// base64 → char-shift(-3) → reverse → base64 → JSON) yields { source, … }.
// Ported from StreamFlix's DecryptHelper.decryptF7. voe.sx DDoS-Guards server
// egress, so this only fires on Browser-Rendering output (a real browser clears
// the challenge); the decode itself is what plain regex can't do.
function decodeVoe(encoded: string): { url: string; isHls: boolean } | null {
  try {
    let v = encoded.replace(/[a-zA-Z]/g, (c) => {
      const base = c <= "Z" ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
    for (const p of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]) v = v.split(p).join("_");
    v = v.replace(/_/g, "");
    v = atob(v);
    v = v.split("").map((c) => String.fromCharCode(c.charCodeAt(0) - 3)).join("");
    v = atob(v.split("").reverse().join(""));
    const src = JSON.parse(v)?.source;
    if (typeof src === "string" && src.startsWith("http")) return { url: src, isHls: src.includes(".m3u8") };
  } catch { }
  return null;
}

// Pull a playable media URL out of rendered page HTML. VOE's encrypted JSON
// first (domain-agnostic — its aliases rotate), then a bare HLS/MP4/MediaFire
// link (some players build the src in JS, which the render surfaces).
function findMediaUrl(html: string): { url: string; isHls: boolean } | null {
  const jm = html.match(/<script\s+type="application\/json">([\s\S]*?)<\/script>/);
  if (jm) {
    const voe = decodeVoe(jm[1].trim());
    if (voe) return voe;
  }
  const m3u8 = html.match(/https?:\/\/[^"'\s\\<>]+\.m3u8[^"'\s\\<>]*/);
  if (m3u8) return { url: m3u8[0], isHls: true };
  const mf = html.match(/https:\/\/download\d+\.mediafire\.com[^"'\s\\<>]+/);
  if (mf) return { url: mf[0], isHls: false };
  const mp4 = html.match(/https?:\/\/[^"'\s\\<>]+\.mp4[^"'\s\\<>]*/);
  if (mp4) return { url: mp4[0], isHls: false };
  return null;
}

// Cached browser-render resolve: render an embed once and reuse the result.
// Browser Rendering is slow (~10-20s) and metered, so the outcome — a resolved
// { url, isHls } or a miss — is cached in KV per embed URL (short TTL because
// the URLs are signed/expiring). No-ops to null when rendering is unconfigured.
async function resolveViaRender(
  embedUrl: string,
  env: Env,
): Promise<{ url: string; isHls: boolean } | null> {
  if (!browserRenderingReady(env)) return null;
  const key = `rr:${embedUrl}`;
  const cached = await cacheGet(key, env.STREAM_CACHE) as { url: string; isHls: boolean; miss?: boolean } | null;
  if (cached) return cached.miss ? null : cached;
  const html = await renderPage(embedUrl, env, { referer: embedUrl });
  const media = html ? findMediaUrl(html) : null;
  await cacheSet(key, media ?? { miss: true }, media ? TTL.render : TTL.renderMiss, env.STREAM_CACHE);
  return media;
}

// ─── MEDIAFIRE RESOLVER ────────────────────────────────────────────────────
// GET mediafire.com/file/{key}/{name}/file → the CDN URL used to be inline in
// the HTML (download{n}.mediafire.com → 206, video/mp4, Accept-Ranges). As of
// mid-2026 MediaFire builds that link in JS, so plain fetch can only succeed
// when the static URL is still present; otherwise it returns null and the
// caller falls back to browser rendering. It never returns the page URL — a
// non-video link that only produced a dead "stream".
async function resolveMediafire(mfUrl: string): Promise<string | null> {
  try {
    const r = await fetch(mfUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        "Referer": "https://www.mediafire.com/",
        "Accept-Language": "es-MX,es;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const match = html.match(/https:\/\/download\d+\.mediafire\.com[^"'\s]+/);
    return match ? match[0] : null;
  } catch { return null; }
}

function parseEpisodeEmbeds(html: string) {
  const embedUrls: { url: string; name: string }[] = [];
  const seen = new Set<string>();

  // The site has used two encodings for data-player:
  //   • full base64 of the provider URL (current as of 2026-07, all players)
  //   • literal path suffix appended to the data-key base64 prefix
  // Decode-first handles both: a literal suffix never base64-decodes to a URL,
  // and concatenating the current prefix ("…/reproductor?url=") only yields
  // latanime's JS wrapper page, whose provider host the extractors below
  // can never see.
  const keyM = html.match(/data-key="([A-Za-z0-9+/=]+)"/);
  const baseUrl = keyM ? (() => { try { return atob(keyM[1]); } catch { return ""; } })() : "";

  for (const m of html.matchAll(/<a[^>]+data-player="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const raw  = m[1].trim();
    const name = m[2].replace(/<[^>]+>/g, "").trim() || "Player";
    if (seen.has(raw)) continue;
    seen.add(raw);

    let embedUrl = "";
    try {
      const decoded = atob(raw);
      if (decoded.startsWith("http") || decoded.startsWith("//")) embedUrl = decoded;
    } catch { }
    if (!embedUrl && baseUrl) embedUrl = baseUrl + raw;

    if (embedUrl.startsWith("//")) embedUrl = `https:${embedUrl}`;
    if (!embedUrl.startsWith("http")) continue;
    embedUrls.push({ url: embedUrl, name });
  }

  // Scrape download mirror links directly from episode page
  const mirrors: { mediafire?: string; savefiles?: string; pixeldrain?: string; mega?: string; gofile?: string } = {};
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = m[1].trim();
    if (href.includes("mediafire.com") && href.includes("/file/") && !mirrors.mediafire) mirrors.mediafire = href;
    else if (href.includes("savefiles.com") && !href.includes("/d/") && !mirrors.savefiles) mirrors.savefiles = href;
    else if (href.includes("pixeldrain.com") && !mirrors.pixeldrain) mirrors.pixeldrain = href;
    else if (href.includes("mega.nz") && !mirrors.mega) mirrors.mega = href;
    else if (href.includes("gofile.io") && !mirrors.gofile) mirrors.gofile = href;
  }

  return { embedUrls, mirrors };
}

async function getStreams(rawId: string, env: Env, request: Request) {
  const parts = rawId.replace("latanime:", "").split(":");
  if (parts.length < 2) return { streams: [] };
  const [slug, epNum] = parts;

  const html = await fetchHtml(`${BASE_URL}/ver/${slug}-episodio-${epNum}`, env);
  const { embedUrls, mirrors } = parseEpisodeEmbeds(html);

  if (embedUrls.length === 0 && Object.keys(mirrors).length === 0) return { streams: [] };

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

  const streams: any[] = [];
  const extractedNames = new Set<string>();

  // Every extraction — mirrors and embeds — is a task yielding a playable URL
  // plus the referer its HLS segments must be fetched with. Referer is decided
  // where the host is known; the assembly loop below stays host-agnostic.
  // `proxied` marks a URL that is already a finished, web-ready stream (e.g. the
  // Deno savefiles HLS) so the assembly doesn't re-wrap it in the worker proxy.
  type Extracted = { url: string; name: string; isHls: boolean; referer?: string; priority?: boolean; proxied?: boolean };
  const tasks: Promise<Extracted | null>[] = [];

  // Deno service base (FETCH_PROXY_URL is …/fetch); used for the savefiles HLS
  // resolver, which must run extraction + playback from one stable IP.
  const denoBase = (env.FETCH_PROXY_URL || "").trim().replace(/\/fetch\/?$/, "").replace(/\/$/, "");

  // Priority: MediaFire — direct MP4, seekable, no expiry, ~185MB/ep.
  // Manual first; if MediaFire's JS-built link defeats it, render the page.
  if (mirrors.mediafire) {
    tasks.push((async () => {
      let cdnUrl = await resolveMediafire(mirrors.mediafire!);
      if (!cdnUrl) {
        const html = await renderPage(mirrors.mediafire!, env, { referer: "https://www.mediafire.com/" });
        cdnUrl = html ? (findMediaUrl(html)?.url ?? null) : null;
      }
      if (!cdnUrl) return null;
      return { url: cdnUrl, name: "🔥 MediaFire MP4", isHls: false, priority: true };
    })());
  }

  // Priority: Pixeldrain — direct stream, Stremio fetches from user's residential IP
  const pixeldrainSrc = mirrors.pixeldrain || embedUrls.find((e) => e.url.includes("pixeldrain.com"))?.url;
  if (pixeldrainSrc) {
    const idM = pixeldrainSrc.match(/pixeldrain\.com\/(?:u|l)\/([a-zA-Z0-9]+)/);
    if (idM) tasks.push(Promise.resolve({ url: `https://pixeldrain.com/api/file/${idM[1]}`, name: "Pixeldrain", isHls: false, priority: true }));
  }

  // savefiles HLS via the Deno resolver — savefiles binds the signed URL to the
  // extractor's IP, so the whole flow (extract + all segment fetches) runs on
  // Deno's one stable IP and the token stays valid. Deno serves it web-ready.
  const savefilesSrc = mirrors.savefiles || embedUrls.find((e) => e.url.includes("savefiles.com") || e.url.includes("streamhls.to"))?.url;
  if (denoBase && savefilesSrc) {
    const code = savefilesSrc.split(/savefiles\.com\/|streamhls\.to\//).pop()?.replace(/^e\//, "").split(/[/?]/)[0]?.trim();
    if (code && code.length > 3) {
      tasks.push(Promise.resolve({ url: `${denoBase}/savefiles?code=${encodeURIComponent(code)}`, name: "savefiles 1080p", isHls: true, proxied: true }));
    }
  }

  for (const embed of embedUrls) {
    if (embed.url.includes("pixeldrain.com")) { extractedNames.add(embed.name); continue; } // handled above
    // savefiles/streamhls handled above via Deno (when configured); mark it
    // extracted so it isn't also shown as an externalUrl. Without a Deno base it
    // falls through to an externalUrl instead. mixdrop mints IP-bound signed
    // URLs too but is a single MP4 — server-side extraction 403s from another
    // IP, so skip it and let the user's own client resolve the externalUrl.
    if (embed.url.includes("savefiles.com") || embed.url.includes("streamhls.to")) {
      if (denoBase) extractedNames.add(embed.name);
      continue;
    }
    if (/mi+xdrop/.test(embed.url)) {
      continue;
    }
    tasks.push((async () => {
      if (embed.url.includes("hexload.com")) {
        const url = await extractHexload(embed.url);
        return url ? { url, name: embed.name, isHls: false } : null;
      }
      if (embed.url.includes("mp4upload.com")) {
        const url = await extractMp4upload(embed.url);
        return url ? { url, name: embed.name, isHls: false } : null;
      }
      // No manual extractor for this host (JS-challenge/SPA players like voe,
      // dsvplay, bysekoze). Render it with Browser Rendering if configured
      // (cached per embed); findMediaUrl decodes VOE's blob or a bare src.
      const media = await resolveViaRender(embed.url, env);
      if (media) return { url: media.url, name: embed.name, isHls: media.isHls, referer: embed.url };
      // Still nothing — falls through to an externalUrl entry below, playable
      // in the user's own client.
      return null;
    })());
  }

  const results = await Promise.allSettled(tasks);

  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      const { url: streamUrl, name, isHls, referer, priority, proxied } = r.value;
      const hlsReferer = referer || "https://latanime.org/";
      // proxied streams (Deno savefiles HLS) are already finished + web-ready;
      // everything else HLS goes through the worker proxy.
      const finalUrl = (isHls && !proxied) ? hlsProxyUrl(streamUrl, hlsReferer) : streamUrl;
      if (!streams.some(s => s.url === finalUrl)) {
        // title only, never title AND description: stremio-core deserializes
        // title as a serde alias of description, and serde rejects an object
        // carrying both as a duplicate field — every such stream is silently
        // dropped by the new (Rust-core) Android/Web clients. Legacy clients
        // read title directly.
        const label = `▶ ${name} — Latino`;
        const entry = {
          url: finalUrl,
          name: `Latanime ${isHls ? "HLS" : "MP4"}`,
          title: label,
          behaviorHints: {
            // worker-proxied and Deno-proxied HLS are served with CORS over
            // https, so the web player can use them; only externally proxied
            // HLS (MFP) is opaque
            notWebReady: isHls && !proxied && !finalUrl.startsWith(workerBase),
            // filename drives format detection in Stremio's local streaming
            // server — the proxied URLs carry no usable extension themselves
            filename: `${slug}-e${epNum}.${isHls ? "m3u8" : "mp4"}`,
            bingeGroup: `latanime-${name}`,
          },
        };
        if (priority) streams.unshift(entry); else streams.push(entry);
      }
      extractedNames.add(name);
    }
  }

  for (const embed of embedUrls) {
    if (!extractedNames.has(embed.name)) {
      const label = `🌐 ${embed.name} — Latino`;
      // Embed pages are HTML, not video — externalUrl is the spec-correct
      // field, and unlike notWebReady url streams it stays visible on
      // Stremio Web even when every extractor above failed.
      streams.push({
        externalUrl: embed.url,
        name: "Latanime 🌐",
        title: label,
      });
    }
  }

  return { streams };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const tmdbKey = (env.TMDB_KEY || "").trim();

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (path === "/" || path === "/manifest.json") return json(MANIFEST);

    if (path === "/debug") {
      return json({
        tmdbKey: tmdbKey ? "set" : "not set",
        kvBinding: env.STREAM_CACHE ? "set" : "not set",
        fetchProxy: (env.FETCH_PROXY_URL || "").trim() || "not set",
        browserRendering: browserRenderingReady(env) ? "enabled" : "disabled (manual only)",
      });
    }

    if (path === "/debug-render") {
      const testUrl = url.searchParams.get("url");
      if (!testUrl) return json({ error: "Missing ?url=" });
      const t0 = Date.now();
      const html = await renderPage(testUrl, env, { referer: url.searchParams.get("ref") || "https://latanime.org/" });
      if (html == null) return json({ error: "render returned null — CF_ACCOUNT_ID/CF_API_TOKEN unset or render failed", ms: Date.now() - t0 });
      return json({ testUrl, htmlLen: html.length, media: findMediaUrl(html), ms: Date.now() - t0 });
    }

    if (path === "/debug-host") {
      const embedUrl = url.searchParams.get("url");
      if (!embedUrl) return new Response("Missing url", { status: 400 });
      const hdrs = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", "Referer": "https://latanime.org/", "Origin": "https://latanime.org", "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "es-ES,es;q=0.9" };
      try {
        const r = await fetch(embedUrl, { headers: hdrs, signal: AbortSignal.timeout(10000) });
        const html = await r.text();
        const urls = [...html.matchAll(/["'`](https?:\/\/[^"'`\s]{15,}\.(?:mp4|mkv|m3u8|ts)[^"'`\s]*)/gi)].map((m) => m[1]);
        return json({ status: r.status, contentType: r.headers.get("content-type"), htmlLen: html.length, foundUrls: urls, htmlSnippet: html.slice(0, 5000) });
      } catch (e) { return json({ error: String(e) }); }
    }

    if (path === "/debug-extract") {
      // Runs every extractor for one episode with per-provider outcome and
      // timing, so extraction failures can be diagnosed from the deployed
      // worker (e.g. hosts blocking Cloudflare egress).
      // Usage: /debug-extract?id=black-torch-castellano:1
      const id = url.searchParams.get("id") || "";
      const [slug, ep] = id.split(":");
      if (!slug || !ep) return json({ error: "Missing ?id=slug:episode" });
      const t0 = Date.now();
      try {
        const html = await fetchHtml(`${BASE_URL}/ver/${slug}-episodio-${ep}`, env);
        const { embedUrls, mirrors } = parseEpisodeEmbeds(html);
        const tests: { name: string; ok: boolean; ms: number; result?: string; error?: string }[] = [];
        const tryX = async (name: string, fn: () => Promise<string | null>) => {
          const t = Date.now();
          try {
            const r = await fn();
            tests.push({ name, ok: !!r, ms: Date.now() - t, result: r ? r.slice(0, 140) : undefined });
          } catch (e) {
            tests.push({ name, ok: false, ms: Date.now() - t, error: String(e).slice(0, 200) });
          }
        };
        await Promise.all([
          mirrors.mediafire ? tryX("mirror:mediafire", () => resolveMediafire(mirrors.mediafire!)) : Promise.resolve(),
          mirrors.savefiles ? tryX("mirror:savefiles", () => extractSavefiles(mirrors.savefiles!)) : Promise.resolve(),
          ...embedUrls.map((e) => {
            if (e.url.includes("hexload.com")) return tryX(`embed:${e.name}`, () => extractHexload(e.url));
            if (e.url.includes("mp4upload.com")) return tryX(`embed:${e.name}`, () => extractMp4upload(e.url));
            if (e.url.includes("savefiles.com") || e.url.includes("streamhls.to")) return tryX(`embed:${e.name}`, () => extractSavefiles(e.url));
            if (/mi+xdrop/.test(e.url)) return tryX(`embed:${e.name}`, () => extractMixdrop(e.url));
            return tryX(`render:${e.name}`, async () => {
              const h = await renderPage(e.url, env, { referer: e.url });
              return h ? (findMediaUrl(h)?.url ?? null) : null;
            });
          }),
        ]);
        return json({
          id, totalMs: Date.now() - t0,
          episodeFetch: "ok",
          embeds: embedUrls.map((e) => `${e.name}: ${e.url}`),
          mirrors,
          tests: tests.sort((a, b) => Number(b.ok) - Number(a.ok)),
        });
      } catch (e) {
        return json({ id, totalMs: Date.now() - t0, episodeFetch: "FAILED", error: String(e).slice(0, 300) });
      }
    }

    if (path === "/debug-savefiles") {
      const code = url.searchParams.get("code") || "hxhufbkiftyf";
      const t0 = Date.now();
      const streamUrl = await extractSavefiles(`https://savefiles.com/${code}`);
      const workerBase = new URL(request.url).origin;
      const proxyUrl = streamUrl ? `${workerBase}/proxy/m3u8?url=${encodeURIComponent(streamUrl)}&ref=${encodeURIComponent("https://streamhls.to/")}` : null;
      return json({ code, streamUrl, proxyUrl, ms: Date.now() - t0 });
    }

    if (path === "/debug-mixdrop") {
      const testUrl = url.searchParams.get("url");
      if (!testUrl) return json({ error: "Missing ?url=" });
      const t0 = Date.now();
      const streamUrl = await extractMixdrop(testUrl);
      return json({ testUrl, streamUrl, ms: Date.now() - t0 });
    }

    if (path === "/cache-clear") {
      // Takes the full KV key incl. prefix — live prefixes are catalog:,
      // meta:, stream:v2: and rr: (old br: and unversioned stream: are gone).
      const key = url.searchParams.get("key");
      if (key && env.STREAM_CACHE) {
        await env.STREAM_CACHE.delete(key);
        return json({ cleared: key });
      }
      return json({ error: "Missing ?key= (full KV key, e.g. stream:latanime:slug:1) or no KV binding" });
    }

    if (path === "/_health") {
      return json({ status: "alive", version: MANIFEST.version, kv: env.STREAM_CACHE ? "bound" : "missing" });
    }

    const catM = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/);
    if (catM) {
      const [, , catalogId, extraStr] = catM;
      const extra: Record<string, string> = {};
      if (extraStr) extraStr.split("&").forEach((p) => { const [k, v] = p.split("="); if (k && v) extra[k] = decodeURIComponent(v); });
      if (url.searchParams.get("search")) extra.search = url.searchParams.get("search")!;
      if (url.searchParams.get("genre")) extra.genre = url.searchParams.get("genre")!;
      const cacheKey = `catalog:${catalogId}:${extra.search || ""}:${extra.genre || ""}:${extra.skip || ""}`;
      const cached = await cacheGet(cacheKey, env.STREAM_CACHE);
      if (cached) return json(cached);
      try { const result = await getCatalog(catalogId, extra, env); await cacheSet(cacheKey, result, TTL.catalog, env.STREAM_CACHE); return json(result); }
      catch (e) { return json({ metas: [], error: String(e) }); }
    }

    const metaM = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
    if (metaM) {
      const id = decodeURIComponent(metaM[2]);
      const cached = await cacheGet(`meta:${id}`, env.STREAM_CACHE);
      if (cached) return json(cached);
      try { const result = await getMeta(id, tmdbKey, env); await cacheSet(`meta:${id}`, result, TTL.meta, env.STREAM_CACHE); return json(result); }
      catch (e) { return json({ meta: null, error: String(e) }); }
    }

    const streamM = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (streamM) {
      const id = decodeURIComponent(streamM[2]);
      // v2: pre-4.9.2 cached entries carry title+description, which Rust-core
      // clients drop as invalid — keying past them instead of serving them out
      const cached = await cacheGet(`stream:v2:${id}`, env.STREAM_CACHE);
      if (cached) return json(cached);
      try {
        const result = await getStreams(id, env, request);
        if (result.streams.length > 0) await cacheSet(`stream:v2:${id}`, result, TTL.stream, env.STREAM_CACHE);
        return json(result);
      } catch (e) { return json({ streams: [], error: String(e) }); }
    }

    if (path === "/proxy/m3u8") {
      const m3u8Url = url.searchParams.get("url");
      const referer = url.searchParams.get("ref") || "https://latanime.org/";
      if (!m3u8Url) return new Response("Missing url", { status: 400 });
      try {
        // searchParams.get() already percent-decodes — decoding again would
        // corrupt upstream URLs that carry literal %-sequences (signed tokens)
        const base = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);
        const workerBase = new URL(request.url).origin;
        const proxied = (absUrl: string, forceM3u8 = false) => {
          const route = forceM3u8 || absUrl.includes(".m3u8") ? "m3u8" : "seg";
          return `${workerBase}/proxy/${route}?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer)}`;
        };
        const r = await fetch(m3u8Url, { headers: { "Referer": referer, "Origin": new URL(referer).origin, "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1" }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) return new Response(`Upstream ${r.status}`, { status: r.status });
        const m3u8Text = await r.text();
        const isMaster = m3u8Text.includes("#EXT-X-STREAM-INF");
        const rewritten = m3u8Text.split("\n").map((line) => {
          const trimmed = line.trim();
          if (trimmed === "") return line;
          if (trimmed.startsWith("#")) {
            // EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA reference URLs via URI="…" —
            // they need the same referer treatment as segments
            const uriM = line.match(/URI="([^"]+)"/);
            if (!uriM) return line;
            const absUri = uriM[1].startsWith("http") ? uriM[1] : base + uriM[1];
            return line.replace(uriM[1], proxied(absUri));
          }
          const absUrl = trimmed.startsWith("http") ? trimmed : base + trimmed;
          // in a master playlist every non-# line is a variant playlist,
          // whatever its extension
          return proxied(absUrl, isMaster);
        }).join("\n");
        return new Response(rewritten, { headers: { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" } });
      } catch (e) { return new Response(String(e), { status: 500 }); }
    }

    if (path === "/proxy/seg") {
      const segUrl = url.searchParams.get("url");
      const referer = url.searchParams.get("ref") || "https://latanime.org/";
      if (!segUrl) return new Response("Missing url", { status: 400 });
      try {
        // deliberately no AbortSignal here: the response body is streamed, and
        // a timeout signal would abort slow segment downloads mid-stream
        const r = await fetch(segUrl, { headers: { "Referer": referer, "Origin": new URL(referer).origin, "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1" } });
        if (!r.ok) return new Response(`Upstream ${r.status}`, { status: r.status });
        return new Response(r.body, { headers: { "Content-Type": r.headers.get("Content-Type") || "video/MP2T", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } });
      } catch (e) { return new Response(String(e), { status: 500 }); }
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
