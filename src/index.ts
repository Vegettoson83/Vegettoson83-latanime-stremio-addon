/**
 * LATANIME STREMIO ADDON — v1.1
 * Cloudflare Worker — Serverless, Free Tier
 */

const ADDON_ID = "com.latanime.stremio";
const BASE_URL = "https://latanime.org";

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

  function extractCard(slug: string, block: string) {
    if (seen.has(slug)) return;
    seen.add(slug);
    const titleM =
      block.match(/title="([^"]+)"/) ||
      block.match(/class="[^"]*title[^"]*"[^>]*>([^<]+)</);
    let name = titleM ? titleM[1] : slug;
    name = name.replace(/<[^>]+>/g, "").trim();
    const posterM = block.match(/(?:src|data-src)=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)/i);
    const poster = posterM
      ? (posterM[1].startsWith("http") ? posterM[1] : `${BASE_URL}${posterM[1]}`)
      : "";
    results.push({ id: `latanime:${slug}`, name, poster });
  }

  for (const m of html.matchAll(
    /<a[^>]+href="(?:https?:\/\/latanime\.org)?\/anime\/([a-z0-9-]+)"[^>]*class="[^"]*(?:anime-card|thumb)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  )) extractCard(m[1], m[2]);

  for (const m of html.matchAll(
    /<a[^>]*class="[^"]*(?:anime-card|thumb)[^"]*"[^>]*href="(?:https?:\/\/latanime\.org)?\/anime\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi
  )) extractCard(m[1], m[2]);

  if (results.length === 0) {
    for (const m of html.matchAll(
      /<a[^>]+href="(?:https?:\/\/latanime\.org)?\/anime\/([a-z0-9-]+)"[^>]*>([\s\S]{0,800}?)<\/a>/gi
    )) {
      const block = m[2];
      const titleM =
        block.match(/title="([^"]+)"/) ||
        block.match(/<p[^>]*>([\s\S]*?)<\/p>/) ||
        block.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/);
      const name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : m[1];
      const posterM = block.match(/(?:src|data-src)=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)/i);
      const poster = posterM
        ? (posterM[1].startsWith("http") ? posterM[1] : `${BASE_URL}${posterM[1]}`)
        : "";
      if (!seen.has(m[1])) { seen.add(m[1]); results.push({ id: `latanime:${m[1]}`, name, poster }); }
    }
  }

  return results.slice(0, 50);
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

async function getCatalog(catalogId: string, extra: Record<string, string>) {
  const search = extra.search?.trim();
  if (search) {
    const html = await fetchHtml(`${BASE_URL}/animes?q=${encodeURIComponent(search)}`);
    return { metas: parseAnimeCards(html).map(toMetaPreview) };
  }
  if (catalogId === "latanime-airing") {
    const html = await fetchHtml(`${BASE_URL}/emision`);
    return { metas: parseAnimeCards(html).map(toMetaPreview) };
  }
  const html = await fetchHtml(`${BASE_URL}/`);
  return { metas: parseAnimeCards(html).map(toMetaPreview) };
}

async function getMeta(id: string) {
  const slug = id.replace("latanime:", "");
  const html = await fetchHtml(`${BASE_URL}/anime/${slug}`);

  const titleM =
    html.match(/<h1[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<title>(.*?)\s*[-–|].*?<\/title>/i);
  const name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : slug;

  const posterM =
    html.match(/<img[^>]+class="[^"]*(?:cover|poster|anime-img)[^"]*"[^>]+(?:src|data-src)="([^"]+)"/i) ||
    html.match(/(?:src|data-src)="(https?:\/\/latanime\.org\/[^"]*\.(?:jpg|png|webp|jpeg)[^"]*)"/i);
  const poster = posterM
    ? (posterM[1].startsWith("http") ? posterM[1] : `${BASE_URL}${posterM[1]}`)
    : "";

  const descM =
    html.match(/<div[^>]*class="[^"]*sinopsis[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
    html.match(/<p[^>]*class="[^"]*desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  const description = descM ? descM[1].replace(/<[^>]+>/g, "").trim() : "";

  const genres: string[] = [];
  for (const gm of html.matchAll(/class="[^"]*genre[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/gi)) {
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

  return {
    meta: {
      id,
      type: "series",
      name,
      poster,
      posterShape: "poster",
      description,
      genres: genres.slice(0, 10),
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
    name: "Filemoon",
    pattern: /filemoon\.|moonplayer\./i,
    extract: async (html) => {
      const packed = html.match(/eval\(function\(p,a,c,k,e,(?:d|r)\)[\s\S]*?\)\)/);
      if (!packed) {
        const m3u8 = html.match(/file:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
        return m3u8 ? [m3u8[1]] : [];
      }
      const unpacked = unpackJs(packed[0]);
      console.error("[Filemoon] unpacked preview:", unpacked.slice(0, 200));
      const m3u8 = unpacked.match(/https?:\/\/[^"'\s]+\.m3u8(?:[^"'\s]*)/);
      return m3u8 ? [m3u8[0]] : [];
    },
  },
  {
    name: "VidGuard",
    pattern: /vidguard\.|vidhide\.|vgfplay\./i,
    extract: async (html) => {
      const m3u8 = html.match(/hls:\s*["']?(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
      return m3u8 ? [m3u8[1]] : [];
    },
  },
  {
    name: "StreamSB",
    pattern: /streamsb\.|sbplay\.|sbfull\.|sbthe\./i,
    extract: async (_html, embedUrl) => {
      const idM = embedUrl.match(/\/e\/([a-zA-Z0-9]+)/);
      if (!idM) return [];
      const apiUrl = embedUrl.replace(/\/e\//, "/sources48/").replace(/\?.*/, "");
      try {
        const r = await fetch(apiUrl, { headers: { watchsb: "streamsb", referer: embedUrl } });
        const d = await r.json() as { stream_data?: { file?: string } };
        return d?.stream_data?.file ? [d.stream_data.file] : [];
      } catch { return []; }
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
    name: "Generic",
    pattern: /.*/,
    extract: async (html) => {
      return [...html.matchAll(/["'](https?:\/\/[^"'\s]+\.m3u8(?:[^"'\s]*))["']/gi)].map((m) => m[1]);
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

  const dataKeyM =
    html.match(/class="[^"]*player[^"]*"[^>]*data-key="([A-Za-z0-9+/=]+)"/i) ||
    html.match(/data-key="([A-Za-z0-9+/=]+)"[^>]*class="[^"]*player[^"]*"/i) ||
    html.match(/data-key="([A-Za-z0-9+/=]+)"/);
  let baseUrl = "";
  if (dataKeyM) { try { baseUrl = atob(dataKeyM[1]); } catch { /* empty */ } }

  const embedUrls: { url: string; name: string }[] = [];
  const seen = new Set<string>();

  function addEmbed(dataPlayer: string, name: string) {
    if (!dataPlayer || seen.has(dataPlayer)) return;
    seen.add(dataPlayer);
    const cleanName = name.replace(/<[^>]+>/g, "").trim().toLowerCase();
    let embedUrl: string;
    if (cleanName === "yourupload") {
      try { embedUrl = atob(dataPlayer); } catch { return; }
    } else {
      embedUrl = baseUrl ? baseUrl + dataPlayer : dataPlayer;
    }
    if (!embedUrl) return;
    if (embedUrl.startsWith("//")) embedUrl = `https:${embedUrl}`;
    if (!embedUrl.startsWith("http")) return;
    embedUrls.push({ url: embedUrl, name: name.replace(/<[^>]+>/g, "").trim() || "Player" });
  }

  for (const ulM of html.matchAll(/class="[^"]*cap_repro[^"]*"[^>]*>([\s\S]*?)<\/(?:ul|div)>/gi)) {
    for (const aM of ulM[1].matchAll(/<a[^>]+data-player="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      addEmbed(aM[1], aM[2]);
    }
  }
  for (const liM of html.matchAll(/<li[^>]*class="[^"]*cap_repro[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
    for (const aM of liM[1].matchAll(/<a[^>]+data-player="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      addEmbed(aM[1], aM[2]);
    }
  }

  const playVideoM = html.match(/id="play-video"[\s\S]{0,300}?data-player="([^"]+)"/i);
  if (playVideoM) addEmbed(playVideoM[1], "Default");

  const videoLoadingM = html.match(/id="videoLoading"[^>]*data-video="([^"]+)"/i);
  if (videoLoadingM) addEmbed(videoLoadingM[1], "VideoLoading");

  for (const m of html.matchAll(/data-player="([^"]+)"/gi)) addEmbed(m[1], "Player");

  if (embedUrls.length === 0) {
    console.error(`[getStreams] 0 embeds found. URL: ${epUrl}`);
    return { streams: [] };
  }

  const streams: { url: string; title: string; behaviorHints: { notWebReady: boolean } }[] = [];

  for (const embed of embedUrls.slice(0, 6)) {
    try {
      const extractor = EMBED_EXTRACTORS.find((e) => e.pattern.test(embed.url));
      if (!extractor) continue;
      let embedHtml = "";
      try {
        embedHtml = await fetchHtml(embed.url);
      } catch (e) {
        console.error(`[getStreams] fetchHtml failed for ${embed.url}:`, e);
        continue;
      }
      const urls = await extractor.extract(embedHtml, embed.url);
      for (const streamUrl of urls) {
        if (streamUrl?.startsWith("http")) {
          streams.push({
            url: streamUrl,
            title: `🌎 ${embed.name || extractor.name} — Latino`,
            behaviorHints: { notWebReady: false },
          });
        }
      }
    } catch (e) {
      console.error(`[getStreams] Extractor threw for ${embed.url}:`, e);
    }
  }

  return { streams };
}

export default {
  async fetch(request: Request): Promise<Response> {
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

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
