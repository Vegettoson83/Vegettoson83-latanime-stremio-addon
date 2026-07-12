
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

// ─── ANIME ONLINE NINJA ──────────────────────────────────────────────────────
// A DooPlay WordPress site behind a Cloudflare *managed JS challenge* ("Just a
// moment…", cType:'managed') applied site-wide — every path, down to
// robots.txt, returns the interstitial with HTTP 403. This is NOT the
// IP-reputation gate the phase-1 groundwork assumed: the Deno relay does NOT
// clear it (verified — its clean IP gets the same 403 challenge as the Worker).
// A managed JS+Turnstile challenge can only be cleared by a real browser, so
// AON fetches escalate to Cloudflare Browser Rendering (renderPage) when the
// relay comes back challenged. Requires CF_ACCOUNT_ID + CF_API_TOKEN; without
// them AON is unreachable and fetchAon throws a labelled error.
// The public REST API gives structured JSON instead of HTML scraping:
//   • GET /wp-json/dooplay/glossary            — full A–Z catalog listing
//   • GET /wp-json/dooplay/search?keyword=…    — search
//   • GET /wp-json/dooplayer/v1/post/{id}      — resolves a player option to its
//     embed URL (the "reproductor" endpoint) → reuse the host extractors below
//   • GET /wp-json/wp/v2/genres | dtyear | …   — taxonomies for filters
// Episode lists + per-episode player-option ids still come from the anime/
// episode page HTML (custom post types aren't REST-exposed).
const AON_BASE = "https://ww3.animeonline.ninja";

// ─── ANIMEFÉNIX ──────────────────────────────────────────────────────────────
// A second source (animefenix2.tv). Unlike Ninja it's reachable server-side
// (Cloudflare-fronted but no JS challenge), scraped like latanime:
//   • /directorio/anime?p={n}&q={query}   — catalog + search (cards → /{slug})
//   • /{slug}                             — detail (og: title/poster/synopsis)
//   • /{slug}?id={slug}&load=episodes&start={n} — episode-list HTML fragment
//   • /ver/{slug}-{ep}                    — embeds inline as redirect.php?id=…
// ID scheme: af:{slug} series, af:{slug}:{ep} streams. Hosts overlap latanime
// (mp4upload plays inline; voe/streamtape/uqload are IP-bound or JS-gated →
// externalUrl so the user's own client resolves them, never a dead stream).
const AF_BASE = "https://animefenix2.tv";

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
  // Optional residential companion (companion/aon-resolver) base URL. AON's
  // Cloudflare zone blocks every datacenter egress we have; the companion runs
  // a real browser on the user's residential IP and clears the challenge. When
  // set, fetchAon forwards AON fetches to `${AON_COMPANION_URL}/aon?url=…`.
  AON_COMPANION_URL: string;
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
  // Browser Rendering is metered, so cache each render hard — one render per
  // unique embed, reused for every request until it expires. The ceiling is
  // the signed-URL lifetime baked into the rendered result (voe tokens, HLS
  // expires=): cache longer than the token lives and playback 403s. 60 min is
  // aggressive but under typical token life; push higher only if you accept the
  // occasional stale re-render. Misses cache 15 min so a dead host isn't
  // re-rendered (and re-billed) on every request.
  render:    60 * 60,       // 60 min — resolved browser-render result
  renderMiss: 15 * 60,      // 15 min — a host that failed to render
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
  version: "4.12.0",
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
    { type: "series", id: "animefenix-directory", name: "AnimeFénix — Directorio", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    // AON is search-only (isRequired) on purpose: every AON fetch is a metered
    // Browser Render, so we never want a home grid polling it — it surfaces only
    // when the user searches, and results/streams are cached hard afterwards.
    { type: "series", id: "aon-search", name: "Anime Online Ninja", extra: [{ name: "search", isRequired: true }] },
  ],
  idPrefixes: ["latanime:", "af:", "aon:"],
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

// A response is Cloudflare's managed-challenge interstitial, not real content.
function isCfChallenge(body: string): boolean {
  return /<title>Just a moment|_cf_chl_opt|__cf_chl_|challenge-platform|cf-browser-verification/i.test(body);
}

// Cloudflare Browser Rendering navigates a JSON endpoint with Chrome, which
// shows the raw body inside its JSON viewer (`<pre>…</pre>`); pull that back
// out. For an HTML page the rendered DOM is already what callers want, so fall
// through to the whole document.
function unwrapRenderedText(html: string): string {
  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const raw = pre ? pre[1] : html;
  return raw
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ");
}

// Fetch an Anime Online Ninja URL (API JSON or page HTML). The relay is tried
// first (cheap), but AON serves a managed JS challenge site-wide that the relay
// cannot clear, so a challenged response escalates to Browser Rendering — the
// only server-side path that solves it. Returns raw text; callers JSON.parse
// API responses. No 500-byte floor (search hits can be small).
async function fetchAon(pathOrUrl: string, env?: Env, timeoutMs = 12000): Promise<string> {
  const target = pathOrUrl.startsWith("http") ? pathOrUrl : `${AON_BASE}${pathOrUrl}`;

  // 0) Residential companion (companion/aon-resolver). AON gates on IP
  //    reputation + a JS challenge that no datacenter egress clears — not the
  //    relay's clean IP, not Cloudflare's own rendering browser (verified: both
  //    stay stuck on the interstitial). The only client AON lets through is a
  //    real browser on a *residential* IP, so when the user runs the companion
  //    (a headless browser on their own machine that holds cf_clearance) we
  //    forward the fetch there and it comes back cleared. Gated on
  //    AON_COMPANION_URL — unset ⇒ this leg is skipped and AON stays best-effort
  //    via the (currently blocked) relay/render path below.
  const companion = env?.AON_COMPANION_URL?.trim().replace(/\/$/, "");
  if (companion) {
    try {
      const r = await fetch(`${companion}/aon?url=${encodeURIComponent(target)}`, {
        signal: AbortSignal.timeout(Math.max(timeoutMs, 25000)),
      });
      if (r.ok) {
        const body = await r.text();
        if (body && !isCfChallenge(body)) return body;
      }
    } catch { /* companion offline/unreachable — fall through */ }
  }

  // 1) Deno relay — a stable non-Cloudflare egress. Kept as the cheap first
  //    leg in case AON ever drops the challenge; today it comes back challenged.
  let relayBody: string | null = null;
  const proxyBase = env?.FETCH_PROXY_URL?.trim();
  if (proxyBase) {
    try {
      const r = await fetch(`${proxyBase}?url=${encodeURIComponent(target)}`, {
        headers: { "User-Agent": CHROME_UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await r.text();
      if (r.ok && !isCfChallenge(body)) return body;
      relayBody = body;
    } catch { /* fall through to Browser Rendering */ }
  }

  // 2) Managed challenge (or relay unavailable) — clear it with a real browser.
  //    The interstitial idles before it self-solves, so waitUntil alone captures
  //    "Just a moment…". Instead wait for a selector that only exists once the
  //    challenge has redirected to real content: for the JSON REST endpoints
  //    that's Chrome's JSON-viewer <pre>; for HTML pages it's a WordPress asset
  //    link / theme footer the interstitial never carries.
  if (env && browserRenderingReady(env)) {
    const isApi = /\/wp-json\//i.test(target);
    const rendered = await renderPage(target, env, {
      referer: `${AON_BASE}/`,
      wait: "domcontentloaded",
      waitForSelector: isApi ? "pre" : "link[href*='wp-content'], footer, #footer, #playeroptionsul",
      timeoutMs: Math.max(timeoutMs, 25000),
    });
    if (rendered && !isCfChallenge(rendered)) return unwrapRenderedText(rendered);
    if (rendered) throw new Error("AON: Browser Rendering ran but the Cloudflare challenge did not clear (still interstitial)");
  }

  if (relayBody && isCfChallenge(relayBody)) {
    throw new Error(
      browserRenderingReady(env!)
        ? "AON: relay challenged and Browser Rendering did not return usable content"
        : "AON: Cloudflare managed challenge not cleared — set CF_ACCOUNT_ID/CF_API_TOKEN so fetchAon can escalate to Browser Rendering",
    );
  }
  throw new Error("AON: FETCH_PROXY_URL not set and Browser Rendering unavailable");
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
  if (catalogId.startsWith("animefenix-")) return getAfCatalog(catalogId, extra, env);
  if (catalogId === "aon-search") return getAonCatalog(extra, env);
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
  if (id.startsWith("af:")) return getAfMeta(id, tmdbKey, env);
  if (id.startsWith("aon:")) return getAonMeta(id, tmdbKey, env);
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

// StreamWish (and its rotating aliases — streamwish.to/.top/.com, embedwish,
// wishfast, sfastwish, …) ships its HLS master inside the same p.a.c.k.e.r
// block. The recovered config holds links={"hls2":"…/master.m3u8?…"} (and a
// `file:` fallback). The token is time-windowed, not IP- or referer-locked
// (verified: the master plays with no referer from a fresh IP), so the worker
// serves it through the normal /proxy/m3u8 path. Used by every source that
// embeds StreamWish (latanime, animefenix, Anime Online Ninja).
async function extractStreamwish(embedUrl: string): Promise<string | null> {
  try {
    // Normalise the file/download page to the /e/ embed that carries the packer.
    const embed = embedUrl.replace(/\/(?:f|d|v)\/([a-z0-9]+)/i, "/e/$1");
    const origin = (() => { try { return new URL(embed).origin; } catch { return "https://streamwish.top"; } })();
    const r = await fetch(embed, {
      headers: { "User-Agent": CHROME_UA, "Referer": `${origin}/` },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const unpacked = unpackPacker(html) || html;
    const m =
      unpacked.match(/"hls\d*"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/) ||
      unpacked.match(/file\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/) ||
      unpacked.match(/https?:\/\/[^"'\\ ]+\.m3u8[^"'\\ ]*/);
    return m ? (m[1] || m[0]) : null;
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

async function renderPage(url: string, env: Env, opts: { referer?: string; wait?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2"; timeoutMs?: number; waitForSelector?: string } = {}): Promise<string | null> {
  const acct = (env.CF_ACCOUNT_ID || "").trim();
  const token = (env.CF_API_TOKEN || "").trim();
  if (!acct || !token) return null;
  const timeoutMs = opts.timeoutMs ?? 20000;
  try {
    const body: Record<string, unknown> = {
      url,
      setExtraHTTPHeaders: { Referer: opts.referer ?? "https://latanime.org/" },
      gotoOptions: { waitUntil: opts.wait ?? "networkidle0", timeout: Math.max(6000, timeoutMs - 3000) },
    };
    // Wait for a real-content selector to appear before capturing. This is how a
    // Cloudflare *managed* challenge is cleared server-side: waitUntil fires on
    // the "Just a moment…" interstitial itself (its network idles while the
    // challenge JS counts down), so we instead hold the page open until an
    // element that only exists AFTER the challenge redirects is present. The
    // (previously used) top-level `waitForTimeout` is NOT a /content parameter —
    // it 400s the request — whereas `waitForSelector` is supported.
    if (opts.waitForSelector) {
      body.waitForSelector = { selector: opts.waitForSelector, timeout: Math.min(16000, Math.max(4000, timeoutMs - 4000)) };
    }
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/browser-rendering/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify(body),
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
  if (rawId.startsWith("af:")) return getAfStreams(rawId, env, request);
  if (rawId.startsWith("aon:")) return getAonStreams(rawId, env, request);
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
    // StreamWish mints IP-bound HLS tokens — the premilkyway CDN 403s a fetch
    // from any IP other than the one that resolved the /e/ embed (verified:
    // same-IP extract+play = 200, cross-IP = 403). Same class as savefiles, so
    // resolve AND serve it entirely on Deno's one stable IP; the Worker only
    // points Stremio at ${denoBase}/streamwish. Never extract it Worker-side —
    // that produces a dead stream. Without a Deno base it falls through to an
    // externalUrl (the user's own client resolves it from their IP).
    if (/streamwish|embedwish|wishfast|sfastwish|swishsrv|streamwis/i.test(embed.url)) {
      if (denoBase) {
        tasks.push(Promise.resolve({
          url: `${denoBase}/streamwish?url=${encodeURIComponent(embed.url)}`,
          name: embed.name, isHls: true, proxied: true,
        }));
      }
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

// ─── ANIMEFÉNIX scrapers ─────────────────────────────────────────────────────
// Decode the handful of HTML entities that show up in AnimeFénix titles
// (accented Spanish + the numeric ones). Not a full decoder — just enough.
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&([a-z]+);/gi, (m, e) => (({
      amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…",
      eacute: "é", aacute: "á", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ",
      Eacute: "É", Aacute: "Á", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ",
      uuml: "ü", Uuml: "Ü", ordf: "ª", ordm: "º",
    } as Record<string, string>)[e] ?? m));
}

// AnimeFénix is Cloudflare-fronted but serves content to server IPs (no JS
// challenge). Race a direct Worker fetch against the Deno relay (allowlisted to
// animefenix2.tv) and take whichever returns first — no 500-byte floor because
// the episode-list fragments are legitimately small.
async function fetchAf(url: string, env?: Env, timeoutMs = 12000): Promise<string> {
  const proxyBase = env?.FETCH_PROXY_URL?.trim();
  const pull = async (name: string, r: Promise<Response>) => {
    const res = await r;
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const txt = await res.text();
    if (!txt) throw new Error(`${name}: empty`);
    return txt;
  };
  const racers: Promise<string>[] = [
    pull("direct", fetch(url, { headers: CHROME_HEADERS, signal: AbortSignal.timeout(8000) })),
  ];
  if (proxyBase) {
    racers.push(pull("relay", fetch(`${proxyBase}?url=${encodeURIComponent(url)}`, {
      headers: { "User-Agent": CHROME_UA }, signal: AbortSignal.timeout(timeoutMs),
    })));
  }
  return Promise.any(racers);
}

// Directory/search/home cards: <a href="/{slug}"><figure>…<img src="{poster}"
// alt="{title}">…  The trailing <figure> requirement filters out nav links
// (/directorio, /ver/…, /media) since those aren't card anchors.
function parseAfCards(html: string) {
  const results: { id: string; name: string; poster: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\s+href="\/([a-z0-9][a-z0-9-]+)"\s*>\s*<figure[\s\S]{0,600}?<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"/gi)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const poster = m[2].startsWith("http") ? m[2] : `${AF_BASE}${m[2]}`;
    const name = decodeEntities(m[3]).trim() || slug;
    results.push({ id: `af:${slug}`, name, poster });
  }
  return results.slice(0, 100);
}

async function getAfCatalog(catalogId: string, extra: Record<string, string>, env?: Env) {
  if (extra.search?.trim()) {
    return { metas: parseAfCards(await fetchAf(`${AF_BASE}/directorio/anime?q=${encodeURIComponent(extra.search.trim())}`, env)).map(toMetaPreview) };
  }
  const page = Math.floor(parseInt(extra.skip || "0", 10) / 24) + 1;
  return { metas: parseAfCards(await fetchAf(`${AF_BASE}/directorio/anime?p=${page}`, env)).map(toMetaPreview) };
}

async function getAfMeta(id: string, tmdbKey: string, env?: Env) {
  const slug = id.replace("af:", "");
  const html = await fetchAf(`${AF_BASE}/${slug}`, env);
  const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1]
    || html.match(/<title>\s*(?:Ver\s+)?([\s\S]*?)\s*[-|]\s*AnimeF[eé]nix/i)?.[1] || slug;
  const name = decodeEntities(ogTitle).replace(/^Ver\s+/i, "").trim();
  const poster = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] || "";
  const description = decodeEntities(html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] || "").trim();

  // Episode list is an infinite-scroll HTML fragment: ?id={slug}&load=episodes
  // &start={n}. Each call returns from episode start+1 to the end; paginate by
  // the count seen so far until no new episodes appear (cap the loop).
  const episodes: { id: string; number: number }[] = [];
  const seen = new Set<number>();
  for (let pageN = 0; pageN < 25; pageN++) {
    let frag: string;
    try { frag = await fetchAf(`${AF_BASE}/${slug}?id=${encodeURIComponent(slug)}&load=episodes&start=${seen.size}`, env); }
    catch { break; }
    const before = seen.size;
    for (const em of frag.matchAll(/href="\/ver\/([a-z0-9-]+)-(\d+(?:\.\d+)?)"/gi)) {
      if (em[1] !== slug) continue;
      const num = parseFloat(em[2]);
      if (seen.has(num)) continue;
      seen.add(num);
      episodes.push({ id: `af:${slug}:${num}`, number: num });
    }
    if (seen.size === before) break;
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
      // no released date — AnimeFénix exposes none, and a fake epoch renders
      // as "1969" in the apps (see the latanime videos note)
      videos: episodes.map((ep) => ({ id: ep.id, title: `Episodio ${ep.number}`, season: 1, episode: ep.number })),
    },
  };
}

// Streamtape / uqload mint IP-bound signed URLs and voe is JS-gated, so those
// stay externalUrl (the user's own client resolves them). mp4upload yields a
// plain, cross-IP-playable MP4 — the one host worth extracting inline here.
async function getAfStreams(rawId: string, env: Env, request: Request) {
  const parts = rawId.replace("af:", "").split(":");
  if (parts.length < 2) return { streams: [] };
  const [slug, ep] = parts;
  const html = await fetchAf(`${AF_BASE}/ver/${slug}-${ep}`, env);

  // Real video hosts only — the page also lists ad-redirector layers
  // (re.ironhentai.com/face.php etc.) that are not streams.
  const KNOWN_HOSTS = /(mp4upload|voe|streamtape|uqload|streamwish|filemoon|filelions|vidhide|luluvid|doodstream|dood|okru|ok\.ru|yourupload|sendvid|mixdrop|savefiles|streamhls|hexload|mega\.nz|pixeldrain)/i;
  const embeds: string[] = [];
  const seenEmbed = new Set<string>();
  for (const m of html.matchAll(/redirect\.php\?id=(https?:\/\/[^"'&\s<>]+)/gi)) {
    let u = m[1];
    try { u = decodeURIComponent(u); } catch { }
    if (!KNOWN_HOSTS.test(u) || seenEmbed.has(u)) continue;
    seenEmbed.add(u);
    embeds.push(u);
  }
  if (embeds.length === 0) return { streams: [] };

  const streams: any[] = [];
  for (const embed of embeds) {
    const host = (embed.match(/https?:\/\/(?:www\.)?([a-z0-9-]+\.[a-z.]+)/i)?.[1] || "host").split(".")[0];
    if (embed.includes("mp4upload.com")) {
      const url = await extractMp4upload(embed);
      if (url) {
        const label = `▶ mp4upload — AnimeFénix`;
        streams.push({
          url, name: "AnimeFénix MP4", title: label,
          behaviorHints: { notWebReady: false, filename: `${slug}-e${ep}.mp4`, bingeGroup: "animefenix-mp4upload" },
        });
        continue;
      }
    }
    // IP-bound or JS-gated host → externalUrl, playable in the user's own client
    streams.push({ externalUrl: embed, name: "AnimeFénix 🌐", title: `🌐 ${host} — AnimeFénix` });
  }
  return { streams };
}

// ─── ANIME ONLINE NINJA (aon:) ───────────────────────────────────────────────
// AON is a DooPlay site behind a site-wide Cloudflare managed challenge, so
// every fetch here goes through fetchAon (Deno relay → Browser Rendering). That
// makes each hit a metered ~20s render, so the design is render-frugal:
//   • catalog is search-only (no idle home-grid renders — see MANIFEST),
//   • a stream request spends exactly ONE render (the episode page, whose own JS
//     injects the default player's iframe during the render); no second render
//     on the cold path or the 30s Worker wall blows. Extra player options would
//     need per-option dooplayer/v1/post renders — deliberately left for later.
// The id carries the real page path (base64url) so we never guess DooPlay's
// custom-post-type slug: search/episode links hand us the true permalinks and
// we round-trip them. IDs are ASCII slug paths, so plain btoa/atob suffice.
function aonEncodePath(pathname: string): string {
  return btoa(pathname).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function aonDecodePath(token: string): string {
  try { return atob(token.replace(/-/g, "+").replace(/_/g, "/")); } catch { return ""; }
}

// Walk arbitrary DooPlay search/glossary JSON collecting anime entries. Shapes
// vary across DooPlay versions (array vs numeric-keyed object), so recurse and
// pick any node carrying a title + an animeonline.ninja permalink that isn't an
// episode/genre listing. Poster comes from img/image/thumbnail when present.
function parseAonCards(jsonText: string): { id: string; name: string; poster: string }[] {
  let data: unknown;
  try { data = JSON.parse(jsonText); } catch { return []; }
  const out: { id: string; name: string; poster: string }[] = [];
  const seen = new Set<string>();
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const v of node) visit(v); return; }
    const url = typeof node.url === "string" ? node.url : "";
    const title = typeof node.title === "string" ? node.title
      : typeof node.name === "string" ? node.name : "";
    if (url && title && /animeonline\.ninja/i.test(url) && !/\/(episodio|genero)\//i.test(url)) {
      let pathname = "";
      try { pathname = new URL(url).pathname; } catch { /* skip */ }
      // Skip single-segment index pages (/inicio/, /online/, /temporada/ …)
      if (pathname && pathname.replace(/^\/|\/$/g, "").includes("/")) {
        const id = `aon:${aonEncodePath(pathname)}`;
        if (!seen.has(id)) {
          seen.add(id);
          const raw = typeof node.img === "string" ? node.img
            : typeof node.image === "string" ? node.image
            : typeof node.thumbnail === "string" ? node.thumbnail : "";
          const poster = raw.startsWith("http") ? raw : raw ? `${AON_BASE}${raw}` : "";
          out.push({ id, name: decodeEntities(title).trim(), poster });
        }
      }
    }
    for (const k in node) if (node[k] && typeof node[k] === "object") visit(node[k]);
  };
  visit(data);
  return out.slice(0, 60);
}

async function getAonCatalog(extra: Record<string, string>, env?: Env) {
  const q = (extra.search || "").trim();
  if (!q) return { metas: [] };
  try {
    const txt = await fetchAon(`/wp-json/dooplay/search?keyword=${encodeURIComponent(q)}`, env, 22000);
    return { metas: parseAonCards(txt).map(toMetaPreview) };
  } catch { return { metas: [] }; }
}

async function getAonMeta(id: string, tmdbKey: string, env?: Env) {
  const path = aonDecodePath(id.slice("aon:".length));
  if (!path) return { meta: null };
  let html: string;
  try { html = await fetchAon(path, env, 24000); } catch { return { meta: null }; }

  const name = decodeEntities(
    html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1]
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "")
    || html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]
    || path,
  ).replace(/\s*[-|]\s*(Ver\s+Anime.*|Anime\s*Online.*|VerAnime.*)$/i, "").replace(/^Ver\s+/i, "").trim();
  const poster = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] || "";
  const description = decodeEntities(
    html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] || "",
  ).trim();

  // DooPlay lists episodes as /episodio/{slug}/ anchors (newest first). The
  // episode number is the trailing number in the slug; fall back to encounter
  // order if a slug carries none.
  const episodes: { id: string; number: number }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"']*\/episodio\/([^"'/]+)\/?)["']/gi)) {
    const slug = m[2];
    if (seen.has(slug)) continue;
    seen.add(slug);
    let pathname = "";
    try { pathname = new URL(m[1]).pathname; } catch { continue; }
    if (!pathname) continue;
    const numM = slug.match(/(\d+(?:\.\d+)?)(?!.*\d)/);
    const number = numM ? parseFloat(numM[1]) : seen.size;
    episodes.push({ id: `aon:${aonEncodePath(pathname)}`, number });
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
      videos: episodes.map((ep) => ({ id: ep.id, title: `Episodio ${ep.number}`, season: 1, episode: ep.number })),
    },
  };
}

// Pull embed URLs out of a rendered AON episode page. The render runs the page's
// JS, so the default player option's <iframe> is already injected; some options
// also ship the embed as base64 in a data-* attribute. AON-internal, ad and
// blank frames are dropped.
function parseAonEmbeds(html: string): { url: string; name: string }[] {
  const embeds: { url: string; name: string }[] = [];
  const seen = new Set<string>();
  const push = (raw: string, name: string) => {
    let url = raw.trim();
    if (url.startsWith("//")) url = `https:${url}`;
    if (!/^https?:\/\//i.test(url)) return;
    if (/animeonline\.ninja|about:blank|google\.|disqus|gstatic|doubleclick/i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    embeds.push({ url, name });
  };
  for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) push(m[1], "Reproductor");
  for (const m of html.matchAll(/data-(?:player|embed|src)=["']([A-Za-z0-9+/=]{16,})["']/gi)) {
    try {
      const d = atob(m[1]);
      if (/^https?:\/\//i.test(d) || d.startsWith("//")) push(d, "Reproductor");
    } catch { /* not base64 */ }
  }
  return embeds;
}

// Resolve streams for one AON episode. Exactly one render (the episode page);
// every host from there is resolved without a second render — StreamWish and
// savefiles are IP-bound HLS served through the Deno single-IP resolver (same
// hosts as latanime), mp4upload/hexload/pixeldrain extract cheaply, and anything
// JS-gated (voe, mixdrop, …) is surfaced as an externalUrl the user's own client
// resolves. Never resolve StreamWish/savefiles Worker-side — the token is
// IP-locked and would yield a dead stream.
async function getAonStreams(rawId: string, env: Env, request: Request) {
  const path = aonDecodePath(rawId.slice("aon:".length));
  if (!path) return { streams: [] };
  let html: string;
  try { html = await fetchAon(path, env, 24000); } catch { return { streams: [] }; }

  const embeds = parseAonEmbeds(html);
  if (embeds.length === 0) return { streams: [] };

  const denoBase = (env.FETCH_PROXY_URL || "").trim().replace(/\/fetch\/?$/, "").replace(/\/$/, "");
  const streams: any[] = [];
  const seenUrl = new Set<string>();
  const add = (s: any) => {
    const key = s.url || s.externalUrl;
    if (key && !seenUrl.has(key)) { seenUrl.add(key); streams.push(s); }
  };

  for (const embed of embeds) {
    const host = embed.url.match(/https?:\/\/(?:www\.)?([a-z0-9-]+)\./i)?.[1] || "host";
    const ext = () => add({ externalUrl: embed.url, name: "AnimeOnline Ninja 🌐", title: `🌐 ${host} — AON` });

    if (/streamwish|embedwish|wishfast|sfastwish|swishsrv|streamwis/i.test(embed.url)) {
      if (denoBase) add({ url: `${denoBase}/streamwish?url=${encodeURIComponent(embed.url)}`, name: "AnimeOnline Ninja HLS", title: "▶ streamwish — AON", behaviorHints: { notWebReady: false, filename: "aon.m3u8", bingeGroup: "aon-streamwish" } });
      else ext();
      continue;
    }
    if (/savefiles\.com|streamhls\.to/i.test(embed.url)) {
      const code = embed.url.split(/savefiles\.com\/|streamhls\.to\//).pop()?.replace(/^e\//, "").split(/[/?]/)[0]?.trim();
      if (denoBase && code && code.length > 3) add({ url: `${denoBase}/savefiles?code=${encodeURIComponent(code)}`, name: "AnimeOnline Ninja HLS", title: "▶ savefiles — AON", behaviorHints: { notWebReady: false, filename: "aon.m3u8", bingeGroup: "aon-savefiles" } });
      else ext();
      continue;
    }
    if (embed.url.includes("mp4upload.com")) {
      const u = await extractMp4upload(embed.url);
      if (u) { add({ url: u, name: "AnimeOnline Ninja MP4", title: "▶ mp4upload — AON", behaviorHints: { notWebReady: false, filename: "aon.mp4", bingeGroup: "aon-mp4upload" } }); continue; }
    }
    if (embed.url.includes("hexload.com")) {
      const u = await extractHexload(embed.url);
      if (u) { add({ url: u, name: "AnimeOnline Ninja MP4", title: "▶ hexload — AON", behaviorHints: { notWebReady: false, filename: "aon.mp4", bingeGroup: "aon-hexload" } }); continue; }
    }
    if (embed.url.includes("pixeldrain.com")) {
      const idM = embed.url.match(/pixeldrain\.com\/(?:u|l)\/([a-zA-Z0-9]+)/);
      if (idM) { add({ url: `https://pixeldrain.com/api/file/${idM[1]}`, name: "AnimeOnline Ninja MP4", title: "▶ pixeldrain — AON", behaviorHints: { notWebReady: false, filename: "aon.mp4" } }); continue; }
    }
    // mixdrop, voe and other IP-bound / JS-gated hosts → externalUrl (rendering
    // them here would spend a second render and blow the Worker wall budget).
    ext();
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
        aonCompanion: (env.AON_COMPANION_URL || "").trim() || "not set",
      });
    }

    if (path === "/debug-render") {
      const testUrl = url.searchParams.get("url");
      if (!testUrl) return json({ error: "Missing ?url=" });
      const t0 = Date.now();
      const wait = (url.searchParams.get("wait") as "load" | "domcontentloaded" | "networkidle0" | "networkidle2" | null) || undefined;
      const selector = url.searchParams.get("selector") || undefined;
      const html = await renderPage(testUrl, env, { referer: url.searchParams.get("ref") || "https://latanime.org/", wait, waitForSelector: selector, timeoutMs: selector ? 28000 : undefined });
      if (html == null) return json({ error: "render returned null — CF_ACCOUNT_ID/CF_API_TOKEN unset or render failed", ms: Date.now() - t0 });
      return json({
        testUrl,
        wait: wait || "networkidle0",
        htmlLen: html.length,
        isChallenge: isCfChallenge(html),
        media: findMediaUrl(html),
        snippet: html.slice(0, 600),
        ms: Date.now() - t0,
      });
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
            if (/streamwish|embedwish|wishfast|sfastwish|swishsrv|streamwis/i.test(e.url)) return tryX(`embed:${e.name}`, () => extractStreamwish(e.url));
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

    if (path === "/debug-af") {
      // Exercises the AnimeFénix scrapers end to end for live validation.
      //   /debug-af                  → catalog sample
      //   /debug-af?id=slug          → meta (episode count)
      //   /debug-af?id=slug:episode  → stream embeds + extraction
      const id = url.searchParams.get("id");
      const t0 = Date.now();
      try {
        if (id && id.includes(":")) {
          const result = await getAfStreams(`af:${id}`, env, request);
          const html = await fetchAf(`${AF_BASE}/ver/${id.replace(":", "-")}`, env);
          const embeds = [...html.matchAll(/redirect\.php\?id=(https?:\/\/[^"'&\s<>]+)/gi)].map((m) => { try { return decodeURIComponent(m[1]); } catch { return m[1]; } });
          return json({ id, ms: Date.now() - t0, embeds: [...new Set(embeds)], streams: result.streams });
        }
        if (id) {
          const meta = await getAfMeta(`af:${id}`, (env.TMDB_KEY || "").trim(), env);
          return json({ id, ms: Date.now() - t0, name: meta.meta.name, poster: meta.meta.poster, episodes: meta.meta.videos.length, first: meta.meta.videos.slice(0, 3) });
        }
        const cat = await getAfCatalog("animefenix-directory", {}, env);
        return json({ ms: Date.now() - t0, count: cat.metas.length, sample: cat.metas.slice(0, 5) });
      } catch (e) {
        return json({ id, ms: Date.now() - t0, error: String(e).slice(0, 300) });
      }
    }

    if (path === "/debug-aon") {
      // Probes Anime Online Ninja's DooPlay REST API + a page through the Deno
      // relay + Browser Rendering, dumping raw response shapes so the aon:
      // parsers can be written against real data. AON's managed JS challenge
      // means fetchAon only succeeds when CF_ACCOUNT_ID/CF_API_TOKEN are set
      // (Browser Rendering); the Deno relay alone returns the 403 challenge.
      //   /debug-aon                → glossary + genres + search(naruto)
      //   /debug-aon?q=one+piece    → search only
      //   /debug-aon?player=123     → dooplayer/v1/post/{id}
      //   /debug-aon?url=/anime/…/  → raw text of any AON path (HTML/JSON)
      const q = url.searchParams.get("q");
      const player = url.searchParams.get("player");
      const raw = url.searchParams.get("url");
      const out: Record<string, unknown> = {};
      const grab = async (label: string, p: string, json = true) => {
        const t = Date.now();
        try {
          const txt = await fetchAon(p, env);
          out[label] = {
            ms: Date.now() - t,
            len: txt.length,
            data: json ? JSON.parse(txt) : txt.slice(0, 4000),
          };
        } catch (e) {
          out[label] = { ms: Date.now() - t, error: String(e).slice(0, 200), snippet: undefined };
          // on JSON parse failure, keep a text snippet to eyeball
          try { out[label] = { ...(out[label] as object), snippet: (await fetchAon(p, env)).slice(0, 1500) }; } catch { }
        }
      };
      if (raw) { await grab("url", raw, false); return json(out); }
      if (player) { await grab("player", `/wp-json/dooplayer/v1/post/${encodeURIComponent(player)}`); return json(out); }
      if (q) { await grab("search", `/wp-json/dooplay/search?keyword=${encodeURIComponent(q)}`); return json(out); }
      await Promise.all([
        grab("glossary", `/wp-json/dooplay/glossary`),
        grab("genres", `/wp-json/wp/v2/genres?per_page=5&_fields=id,name,slug,count`),
        grab("search", `/wp-json/dooplay/search?keyword=naruto`),
      ]);
      return json(out);
    }

    if (path === "/debug-savefiles") {
      const code = url.searchParams.get("code") || "hxhufbkiftyf";
      const t0 = Date.now();
      const streamUrl = await extractSavefiles(`https://savefiles.com/${code}`);
      const workerBase = new URL(request.url).origin;
      const proxyUrl = streamUrl ? `${workerBase}/proxy/m3u8?url=${encodeURIComponent(streamUrl)}&ref=${encodeURIComponent("https://streamhls.to/")}` : null;
      return json({ code, streamUrl, proxyUrl, ms: Date.now() - t0 });
    }

    if (path === "/debug-streamwish") {
      // Verify StreamWish unpacking. NOTE: the recovered m3u8 is IP-bound, so
      // this Worker-side streamUrl only plays from the extracting IP — real
      // playback goes through the Deno resolver (denoUrl) that keeps one IP for
      // extraction + segments. This endpoint just confirms the unpack works.
      //   /debug-streamwish?url=https://streamwish.top/e/XXXX
      const testUrl = url.searchParams.get("url");
      if (!testUrl) return json({ error: "Missing ?url= (a streamwish /e/ or /f/ embed)" });
      const t0 = Date.now();
      const streamUrl = await extractStreamwish(testUrl);
      const denoBase = (env.FETCH_PROXY_URL || "").trim().replace(/\/fetch\/?$/, "").replace(/\/$/, "");
      const denoUrl = denoBase ? `${denoBase}/streamwish?url=${encodeURIComponent(testUrl)}` : null;
      return json({ testUrl, unpackedM3u8: streamUrl, denoUrl, ipBound: true, ms: Date.now() - t0 });
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
