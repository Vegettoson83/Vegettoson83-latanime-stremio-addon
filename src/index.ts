
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
  BRIDGE_TOKEN?: string;
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
  version: "4.5.1",
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
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "cross-site",
  "Cache-Control": "max-age=0",
  "Upgrade-Insecure-Requests": "1",
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
      phase1.push(tryFetch("bridge", () =>
        fetch(`${bridgeUrl}/fetch?url=${encoded}`, { signal: AbortSignal.timeout(12000) })
      ));
    }
    try {
      const result = await Promise.any(phase1);
      clearTimeout(globalTimer);
      return result;
    } catch { }

    const proxies = [
      ["allorigins", `https://api.allorigins.win/raw?url=${encoded}`],
      ["codetabs",   `https://api.codetabs.com/v1/proxy?quest=${encoded}`],
      ["corsproxy",  `https://corsproxy.io/?${encoded}`],
    ] as [string, string][];

    for (const [name, proxyUrl] of proxies.sort(() => Math.random() - 0.5)) {
      if (controller.signal.aborted) break;
      try {
        const html = await tryFetch(name, () =>
          fetch(proxyUrl, { headers: { "User-Agent": CHROME_UA }, signal: AbortSignal.timeout(7000 + Math.random() * 5000) })
        );
        clearTimeout(globalTimer);
        return html;
      } catch (e) {
        console.log(`[fetchHtml] ${name} failed: ${e}`);
      }
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
  for (const m of html.matchAll(/href=["'](?:https?:\/\/latanime\.org)?\/anime\/([a-z0-9][a-z0-9-]+)["']/gi)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const pos = m.index! + m[0].length;
    const block = html.slice(pos, pos + 600);
    const titleM = block.match(/<h3[^>]*>([^<]{3,})<\/h3>/i) || block.match(/alt="([^"]{3,})"/) || block.match(/title="([^"]{3,})"/);
    let name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : slug;

    // Clean and Label
    const labels: string[] = [];
    if (name.toLowerCase().includes("latino")) labels.push("Latino");
    if (name.toLowerCase().includes("castellano")) labels.push("Castellano");
    if (block.toLowerCase().includes("pelicula") || block.toLowerCase().includes("película")) labels.push("Pelicula");

    name = name.replace(/\s+(Ver|Sub Español|Latino|Castellano)$/gi, "").trim();
    if (labels.length > 0) name += ` [${labels.join("/")}]`;

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
    const srcMatch = html.match(/sources:\s*\["([^"]+\.m3u8[^"]*)"\]/);
    if (srcMatch) return srcMatch[1];
    const m3u8Match = html.match(/https:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/);
    if (m3u8Match) return m3u8Match[0];
    return null;
  } catch { return null; }
}

async function extractGofile(folderUrl: string) {
  try {
    const folderId = folderUrl.split("/d/").pop()?.split(/[/?]/)[0];
    if (!folderId) return null;

    // Get guest account
    const accR = await fetch("https://api.gofile.io/accounts", { method: "POST" });
    const accData: any = await accR.json();
    const token = accData?.data?.token;
    if (!token) return null;

    const r = await fetch(`https://api.gofile.io/contents/${folderId}?wt=4fd6sg89d7s6`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    const data: any = await r.json();
    const file = Object.values(data?.data?.children || {})[0] as any;
    return file?.directLink || null;
  } catch { return null; }
}

async function extractViaBridge(embedUrl: string, bridgeUrl: string, token?: string) {
  try {
    const auth = token ? `&token=${token}` : "";
    const r = await fetch(`${bridgeUrl}/extract?url=${encodeURIComponent(embedUrl)}${auth}`, { signal: AbortSignal.timeout(50000) });
    if (!r.ok) return null;
    const data: any = await r.json();
    return data.url || null;
  } catch { return null; }
}

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

  const keyM = html.match(/data-key="([A-Za-z0-9+/=]+)"/);
  const baseUrl = keyM ? (() => { try { return atob(keyM[1]); } catch { return ""; } })() : "";

  for (const m of html.matchAll(/<a[^>]+data-player="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const suffix = m[1].trim();
    const name   = m[2].replace(/<[^>]+>/g, "").trim() || "Player";
    if (seen.has(suffix)) continue;
    seen.add(suffix);

    let embedUrl = "";
    if (name.toLowerCase().includes("yourupload")) {
      try { embedUrl = atob(suffix); } catch { continue; }
    } else {
      embedUrl = baseUrl + suffix;
    }
    if (embedUrl.startsWith("//")) embedUrl = `https:${embedUrl}`;
    if (!embedUrl.startsWith("http")) continue;
    embedUrls.push({ url: embedUrl, name });
  }

  const mirrors: { mediafire?: string; savefiles?: string; pixeldrain?: string; mega?: string; gofile?: string } = {};
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = m[1].trim();
    if (href.includes("mediafire.com") && href.includes("/file/") && !mirrors.mediafire) mirrors.mediafire = href;
    else if (href.includes("savefiles.com") && !href.includes("/d/") && !mirrors.savefiles) mirrors.savefiles = href;
    else if (href.includes("pixeldrain.com") && !mirrors.pixeldrain) mirrors.pixeldrain = href;
    else if (href.includes("mega.nz") && !mirrors.mega) mirrors.mega = href.replace("/file/", "/embed/");
    else if (href.includes("gofile.io") && !mirrors.gofile) mirrors.gofile = href;
  }

  const bridgeUrl = (env.BRIDGE_URL || "").trim();
  const bridgeToken = env.BRIDGE_TOKEN || "";
  const mfpBase = (env.MFP_URL || "").trim().replace(/\/$/, "");
  const mfpPass = (env.MFP_PASSWORD || "latanime").trim();
  const workerBase = new URL(request.url).origin;

  function hlsProxyUrl(m3u8Url: string, referer: string) {
    if (mfpBase) {
      const params = new URLSearchParams({ d: m3u8Url, h_Referer: referer, h_Origin: new URL(referer).origin, api_password: mfpPass });
      return `${mfpBase}/proxy/hls/manifest.m3u8?${params}`;
    }
    return `${workerBase}/proxy/m3u8?url=${encodeURIComponent(m3u8Url)}&ref=${encodeURIComponent(referer)}`;
  }

  const BROWSER_PLAYERS = ["filemoon", "voe.sx", "lancewhosedifficult", "voeunblocked", "mxdrop", "dsvplay", "doodstream"];
  const needsBrowser = (url: string) => BROWSER_PLAYERS.some((p) => url.includes(p));

  const streams: any[] = [];
  const extractedNames = new Set<string>();

  interface StreamTaskResult {
    url: string;
    name: string;
    isHls: boolean;
    priority?: boolean;
  }

  const mirrorTasks: Promise<StreamTaskResult | null>[] = [];

  if (mirrors.mediafire) {
    mirrorTasks.push((async (): Promise<StreamTaskResult | null> => {
      const cdnUrl = await resolveMediafire(mirrors.mediafire!);
      return cdnUrl ? { url: cdnUrl, name: "🔥 MediaFire MP4", isHls: false, priority: true } : null;
    })());
  }
  if (mirrors.mega) {
    mirrorTasks.push(Promise.resolve({ url: mirrors.mega, name: "💎 Mega.nz", isHls: false, priority: true }));
  }
  if (mirrors.gofile) {
    mirrorTasks.push((async (): Promise<StreamTaskResult | null> => {
      const direct = await extractGofile(mirrors.gofile!);
      return direct ? { url: direct, name: "🚀 Gofile", isHls: false, priority: true } : null;
    })());
  }

  const results = await Promise.allSettled([
    ...mirrorTasks.map(async (t) => {
      await new Promise((r) => setTimeout(r, Math.random() * 800));
      return t;
    }),
    ...embedUrls.map(async (embed): Promise<StreamTaskResult | null> => {
      await new Promise((r) => setTimeout(r, Math.random() * 1000));
      if (embed.url.includes("pixeldrain.com")) {
        const idM = embed.url.match(/pixeldrain\.com\/(?:u\/|l\/)([a-zA-Z0-9]+)/);
        return idM ? { url: `https://pixeldrain.com/api/file/${idM[1]}`, name: embed.name, isHls: false } : null;
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
      if (needsBrowser(embed.url) || bridgeUrl) {
        const url = await extractViaBridge(embed.url, bridgeUrl, bridgeToken);
        return url ? { url, name: embed.name, isHls: !!url?.includes(".m3u8") } : null;
      }
      return null;
    })
  ]);

  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      const { url: streamUrl, name, isHls, priority } = r.value as StreamTaskResult;
      const isSavefiles = streamUrl.includes("savefiles.com") || streamUrl.includes("streamhls.to");
      const finalUrl = isHls ? hlsProxyUrl(streamUrl, isSavefiles ? "https://streamhls.to/" : "https://latanime.org/") : streamUrl;

      if (!streams.some(s => s.url === finalUrl)) {
        const entry = { url: finalUrl, title: `▶ ${name} — Latino`, behaviorHints: { notWebReady: isHls } };
        if (priority) streams.unshift(entry); else streams.push(entry);
      }
      extractedNames.add(name);
    }
  }

  for (const embed of embedUrls) {
    if (!extractedNames.has(embed.name)) {
      streams.push({ url: embed.url, title: `🌐 ${embed.name} — Latino`, behaviorHints: { notWebReady: true } });
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

    if (path === "/proxy/m3u8") {
      const m3u8Url = url.searchParams.get("url");
      const referer = url.searchParams.get("ref") || "https://latanime.org/";
      if (!m3u8Url) return new Response("Missing url", { status: 400 });
      try {
        const decoded = decodeURIComponent(m3u8Url);
        const base = decoded.substring(0, decoded.lastIndexOf("/") + 1);
        const workerBase = new URL(request.url).origin;
        const r = await fetch(decoded, { headers: { "Referer": referer, "Origin": new URL(referer).origin, "User-Agent": CHROME_UA } });
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
        const r = await fetch(decoded, { headers: { "Referer": referer, "Origin": new URL(referer).origin, "User-Agent": CHROME_UA } });
        if (!r.ok) return new Response(`Upstream ${r.status}`, { status: r.status });
        return new Response(r.body, { headers: { "Content-Type": r.headers.get("Content-Type") || "video/MP2T", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } });
      } catch (e) { return new Response(String(e), { status: 500 }); }
    }

    const catM = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/);
    if (catM) {
      const [, , catalogId, extraStr] = catM;
      const extra: Record<string, string> = {};
      if (extraStr) extraStr.split("&").forEach((p) => { const [k, v] = p.split("="); if (k && v) extra[k] = decodeURIComponent(v); });
      if (url.searchParams.get("search")) extra.search = url.searchParams.get("search")!;
      const cacheKey = `catalog:${catalogId}:${extra.search || extra.skip || ""}`;
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
      const cached = await cacheGet(`stream:${id}`, env.STREAM_CACHE);
      if (cached) return json(cached);
      try {
        const result = await getStreams(id, env, request);
        if (result.streams.length > 0) await cacheSet(`stream:${id}`, result, TTL.stream, env.STREAM_CACHE);
        return json(result);
      } catch (e) { return json({ streams: [], error: String(e) }); }
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
