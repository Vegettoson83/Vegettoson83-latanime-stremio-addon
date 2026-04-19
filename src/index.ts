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
  MYBROWSER: any;
  STREAM_CACHE: any;
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
};

const MANIFEST = {
  id: ADDON_ID,
  version: "4.6.0",
  name: "Latanime",
  description: "Anime Latino y Castellano desde latanime.org — Gofile Direct & Hybrid Resilient Engine",
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
  "Accept-Language": "es-MX,es;q=0.9,en-US;q=0.8",
  "Referer": "https://www.google.com/",
};

async function fetchHtml(url: string, env?: Env): Promise<string> {
  const bridgeUrl = env?.BRIDGE_URL?.trim();
  const encoded = encodeURIComponent(url);
  const proxies = [
    { name: "direct", fetch: () => fetch(url, { headers: CHROME_HEADERS, signal: AbortSignal.timeout(10000) }) },
    { name: "allorigins", fetch: () => fetch(`https://api.allorigins.win/raw?url=${encoded}`, { headers: { "User-Agent": CHROME_UA }, signal: AbortSignal.timeout(15000) }) },
    { name: "codetabs", fetch: () => fetch(`https://api.codetabs.com/v1/proxy?quest=${encoded}`, { headers: { "User-Agent": CHROME_UA }, signal: AbortSignal.timeout(15000) }) },
    { name: "corsproxy", fetch: () => fetch(`https://corsproxy.io/?${encoded}`, { headers: { "User-Agent": CHROME_UA }, signal: AbortSignal.timeout(15000) }) },
  ];
  if (bridgeUrl) proxies.push({ name: "bridge", fetch: () => fetch(`${bridgeUrl}/fetch?url=${encoded}`, { signal: AbortSignal.timeout(20000) }) });

  for (const proxy of proxies) {
    try {
      const r = await proxy.fetch();
      if (r.ok) {
        const html = await r.text();
        if (html.length > 500) return html;
      }
    } catch {}
  }
  throw new Error(`Failed to fetch ${url}`);
}

async function fetchTmdb(name: string, key: string) {
  if (!key) return null;
  const clean = name.replace(/\s+(Latino|Castellano|Japones|Japonés|Sub\s+Español)$/i, "").trim();
  try {
    const r = await fetch(`${TMDB_BASE}/search/tv?api_key=${key}&query=${encodeURIComponent(clean)}&language=es-ES`);
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
    const block = html.slice(m.index! + m[0].length, m.index! + m[0].length + 800);
    const titleM = block.match(/<h3[^>]*>([^<]+)<\/h3>/i) || block.match(/alt="([^"]+)"/) || block.match(/title="([^"]+)"/);
    const name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : slug;
    if (name.length < 2) continue;
    const posterM = block.match(/data-src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) || block.match(/src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/);
    let poster = posterM ? posterM[1] : "";
    if (poster && !poster.startsWith("http")) poster = `${BASE_URL}${poster}`;
    results.push({ id: `latanime:${slug}`, name, poster: poster || `${BASE_URL}/public/img/anime.png` });
  }
  return results;
}

async function searchAnimes(query: string, env?: Env) {
  try {
    const home = await fetchHtml(`${BASE_URL}/`, env);
    const csrf = home.match(/name="csrf-token"[^>]+content="([^"]+)"/i)?.[1];
    const r = await fetch(`${BASE_URL}/buscar_ajax`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrf || "", "X-Requested-With": "XMLHttpRequest", "Referer": `${BASE_URL}/` },
      body: JSON.stringify({ q: query }),
    });
    if (r.ok) return parseAnimeCards(await r.text());
  } catch {}
  return parseAnimeCards(await fetchHtml(`${BASE_URL}/buscar?q=${encodeURIComponent(query)}`, env));
}

async function getMeta(id: string, key: string, env?: Env) {
  const slug = id.replace("latanime:", "");
  const html = await fetchHtml(`${BASE_URL}/anime/${slug}`, env);
  const titleM = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : slug;
  const poster = html.match(/property="og:image"[^>]+content="([^"]+)"/i)?.[1] || "";
  const description = html.match(/class="[^"]*opacity-75[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || "";

  const genres: string[] = [];
  for (const gm of html.matchAll(/href="[^"]*\/genero\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const g = gm[1].replace(/<[^>]+>/g, "").trim();
    if (g) genres.push(g);
  }

  const episodes: any[] = [];
  const seenEps = new Set<string>();
  for (const em of html.matchAll(/href=["'](?:https?:\/\/latanime\.org)?\/ver\/([a-z0-9-]+-episodio-(\d+(?:\.\d+)?))["']/gi)) {
    if (seenEps.has(em[1])) continue;
    seenEps.add(em[1]);
    const num = parseFloat(em[2]);
    episodes.push({ id: `latanime:${slug}:${num}`, title: `Episodio ${num}`, season: 1, episode: num, released: new Date(0).toISOString() });
  }
  episodes.sort((a, b) => a.episode - b.episode);

  const tmdb = await fetchTmdb(name, key);
  return {
    meta: {
      id, type: "series", name,
      poster: tmdb?.poster || poster,
      background: tmdb?.background || poster,
      description: tmdb?.description || description,
      releaseInfo: tmdb?.year || "",
      genres: genres.slice(0, 10),
      videos: episodes,
    }
  };
}

async function extractWithBrowser(embedUrl: string, env: Env): Promise<string | null> {
  if (!env.MYBROWSER) return null;
  try {
    const puppeteer = await import("@cloudflare/puppeteer");
    const browser = await puppeteer.default.launch(env.MYBROWSER);
    const page = await browser.newPage();
    let stream: string | null = null;
    await page.setRequestInterception(true);
    page.on("request", (req: any) => {
      const u = req.url();
      if (!stream && (u.includes(".m3u8") || u.includes(".mp4"))) stream = u;
      req.continue();
    });
    await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
    await browser.close().catch(() => {});
    return stream;
  } catch { return null; }
}

async function extractGofile(folderUrl: string) {
  try {
    const id = folderUrl.split("/d/").pop()?.split(/[/?]/)[0];
    if (!id) return null;
    const acc = await (await fetch("https://api.gofile.io/accounts", { method: "POST" })).json() as any;
    const token = acc.data?.token;
    if (!token) return null;
    const cont = await (await fetch(`https://api.gofile.io/contents/${id}?wt=4fd6sg89d7s6`, { headers: { "Authorization": `Bearer ${token}` } })).json() as any;
    const file = Object.values(cont.data?.children || {})[0] as any;
    return file?.link ? { url: file.link, token } : null;
  } catch { return null; }
}

async function getStreams(rawId: string, env: Env, request: Request) {
  const parts = rawId.replace("latanime:", "").split(":");
  if (parts.length < 2) return { streams: [] };
  const [slug, ep] = parts;
  const html = await fetchHtml(`${BASE_URL}/ver/${slug}-episodio-${ep}`, env);
  const workerBase = new URL(request.url).origin;
  const bridgeUrl = env.BRIDGE_URL?.trim();

  const tasks: Promise<any>[] = [];
  const gofile = html.match(/href=["'](https:\/\/gofile\.io\/d\/[a-zA-Z0-9]+)["']/i)?.[1];
  if (gofile) {
    tasks.push(extractGofile(gofile).then(res => res ? { url: `${workerBase}/proxy/file?url=${encodeURIComponent(res.url)}&token=${res.token}`, name: "🚀 Gofile Direct", priority: true } : null));
  }

  for (const m of html.matchAll(/data-player="([A-Za-z0-9+/=]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = atob(m[1]).startsWith("//") ? `https:${atob(m[1])}` : atob(m[1]);
      const name = m[2].replace(/<[^>]+>/g, "").trim();
      if (url.includes("pixeldrain.com")) {
        const id = url.match(/pixeldrain\.com\/(?:u\/|l\/)([a-zA-Z0-9]+)/)?.[1];
        if (id) tasks.push(Promise.resolve({ url: `https://pixeldrain.com/api/file/${id}`, name: "Pixeldrain" }));
      } else if (url.includes("mediafire.com")) {
        tasks.push(fetch(url).then(r => r.text()).then(h => ({ url: h.match(/https:\/\/download\d+\.mediafire\.com[^"'\s]+/)?.[0], name: "MediaFire" })));
      } else if (url.includes("mega.nz")) {
         const megaEmbed = url.replace("mega.nz/file/", "mega.nz/embed/").replace("mega.nz/#!", "mega.nz/embed/#!");
         tasks.push(Promise.resolve({ url: megaEmbed, name: "Mega", external: true }));
      } else {
        tasks.push(extractWithBrowser(url, env).then(async res => {
          if (res) return { url: res, name };
          if (bridgeUrl) {
            try {
              const brRes = await fetch(`${bridgeUrl}/extract?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(45000) });
              const brData = await brRes.json() as any;
              if (brData.url) return { url: brData.url, name };
            } catch {}
          }
          return { url, name, external: true };
        }));
      }
    } catch {}
  }

  const streams: any[] = [];
  for (let i = 0; i < tasks.length; i += 5) {
    const batch = await Promise.all(tasks.slice(i, i + 5));
    batch.filter(s => s && s.url).forEach(s => {
      const entry = { url: s.url, title: `▶ ${s.name} — Latino`, behaviorHints: { notWebReady: !!s.external } };
      if (s.priority) streams.unshift(entry); else streams.push(entry);
    });
  }
  return { streams };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (path === "/" || path === "/manifest.json") return json(MANIFEST);

    if (path === "/proxy/file") {
      const fileUrlStr = url.searchParams.get("url");
      const token = url.searchParams.get("token");
      if (!fileUrlStr) return new Response("Missing url", { status: 400 });

      try {
        const fileUrl = new URL(fileUrlStr);
        if (!fileUrl.hostname.endsWith(".gofile.io")) return new Response("Forbidden", { status: 403 });

        const r = await fetch(fileUrl.toString(), {
          headers: {
            "Cookie": `accountToken=${token}`,
            "Range": request.headers.get("Range") || "bytes=0-",
            "User-Agent": CHROME_UA
          }
        });
        const headers = new Headers(r.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(r.body, { status: r.status, headers });
      } catch { return new Response("Invalid URL", { status: 400 }); }
    }

    const catM = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/);
    if (catM) {
      const catalogId = catM[2];
      const extra: any = {};
      if (catM[3]) catM[3].split("&").forEach(p => { const [k, v] = p.split("="); extra[k] = decodeURIComponent(v); });
      if (url.searchParams.get("search")) extra.search = url.searchParams.get("search");

      if (extra.search) return json({ metas: (await searchAnimes(extra.search, env)).map(c => ({ ...c, type: "series" })) });
      const page = Math.floor(parseInt(extra.skip || "0") / 30) + 1;
      const target = catalogId === "latanime-airing" ? `${BASE_URL}/emision` : (catalogId === "latanime-directory" ? `${BASE_URL}/animes?page=${page}` : `${BASE_URL}/`);
      return json({ metas: parseAnimeCards(await fetchHtml(target, env)).map(c => ({ ...c, type: "series" })) });
    }

    const metaM = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
    if (metaM) return json(await getMeta(decodeURIComponent(metaM[2]), env.TMDB_KEY || "", env));

    const streamM = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (streamM) return json(await getStreams(decodeURIComponent(streamM[2]), env, request));

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
