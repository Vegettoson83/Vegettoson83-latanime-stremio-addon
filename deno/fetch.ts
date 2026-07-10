// Latanime helper service for Deno Deploy — a stable, non-Cloudflare egress.
//
// Two jobs, both because latanime.org and some video hosts block Cloudflare
// Worker egress (and/or bind signed URLs to the extractor's IP):
//
//   GET /fetch?url=https://latanime.org/...
//       Relays latanime HTML. The Worker can't fetch latanime directly; Deno's
//       egress isn't caught by that block. Allowlisted to latanime.org.
//
//   GET /savefiles?code=<file_code>
//       Resolves a savefiles/streamhls episode to an HLS master playlist and
//       serves it rewritten so every variant/segment is re-fetched through
//       /hls below. savefiles mints signed URLs LOCKED to the IP that did the
//       extraction, so doing the extraction AND all playback fetches here — on
//       Deno's single stable IP — keeps the token valid (the Worker can't: its
//       egress IP differs between extraction and playback, so Stremio got 403).
//
//   GET /hls?u=<abs-url>&r=<referer>
//       Fetches a variant playlist (rewriting it recursively) or a segment
//       (streaming the bytes) with the streamhls referer. Allowlisted to the
//       savefiles/streamhls CDNs.
//
// Deno Deploy runs always-warm isolates, so latency and egress IP stay stable.
// deno.json at the repo root pins the entrypoint to this file. Set the Worker's
// FETCH_PROXY_URL to https://<project>.deno.net/fetch — the Worker derives the
// /savefiles base from it.

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

const STREAMHLS_REFERER = "https://streamhls.to/";

function cors(body: BodyInit | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(body, { ...init, headers });
}

function jsonError(msg: string, status: number): Response {
  return cors(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── /fetch — latanime HTML relay ───────────────────────────────────────────
async function handleFetch(target: string): Promise<Response> {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return jsonError("invalid url", 400);
  }
  // Allowlist: latanime.org (HTML relay), animeonline.ninja (DooPlay REST +
  // pages) and animefenix2.tv (second scrape source). All three block or
  // throttle Cloudflare Worker egress; this relays them from Deno's IP.
  if (u.protocol !== "https:" || !/(^|\.)(latanime\.org|animeonline\.ninja|animefenix2\.tv)$/i.test(u.hostname)) {
    return jsonError("host not allowed", 403);
  }
  try {
    const upstream = await fetch(target, {
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://www.google.com/",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(11000),
    });
    const body = await upstream.text();
    return cors(body, {
      status: upstream.status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  } catch (e) {
    return jsonError(String(e), 502);
  }
}

// ─── savefiles / streamhls HLS ──────────────────────────────────────────────
function hlsHostAllowed(host: string): boolean {
  return /(^|\.)(savefiles\.com|streamhls\.to)$/i.test(host);
}

// Extract the master m3u8 for a file code (same POST the Worker used to do,
// but from Deno's IP so the returned token is bound here).
async function resolveSavefiles(code: string): Promise<string | null> {
  try {
    const r = await fetch("https://streamhls.to/dl", {
      method: "POST",
      headers: {
        "User-Agent": MOBILE_UA,
        "Referer": `https://streamhls.to/e/${code}`,
        "Origin": "https://streamhls.to",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      },
      body: `op=embed&file_code=${code}&auto=1&referer=https://savefiles.com/${code}`,
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
    const html = await r.text();
    const src = html.match(/sources:\s*\["([^"]+\.m3u8[^"]*)"\]/);
    if (src) return src[1];
    const any = html.match(/https:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/);
    return any ? any[0] : null;
  } catch {
    return null;
  }
}

function rewriteM3u8(text: string, sourceUrl: string, selfBase: string, referer: string): string {
  const base = sourceUrl.substring(0, sourceUrl.lastIndexOf("/") + 1);
  const isMaster = text.includes("#EXT-X-STREAM-INF");
  const proxied = (abs: string) =>
    `${selfBase}/hls?u=${encodeURIComponent(abs)}&r=${encodeURIComponent(referer)}`;
  return text.split("\n").map((line) => {
    const t = line.trim();
    if (t === "") return line;
    if (t.startsWith("#")) {
      const uriM = line.match(/URI="([^"]+)"/);
      if (!uriM) return line;
      const absUri = uriM[1].startsWith("http") ? uriM[1] : base + uriM[1];
      return line.replace(uriM[1], proxied(absUri));
    }
    // in a master every non-# line is a variant playlist; in a media playlist
    // it's a segment. Either way, resolve relative → absolute and proxy it.
    const abs = t.startsWith("http") ? t : base + t;
    return proxied(abs);
  }).join("\n");
}

// GET /savefiles?code=... → resolve + serve the rewritten master playlist.
async function handleSavefiles(code: string, selfBase: string): Promise<Response> {
  if (!/^[a-z0-9]{6,}$/i.test(code)) return jsonError("bad code", 400);
  const master = await resolveSavefiles(code);
  if (!master) return jsonError("could not resolve savefiles code", 502);
  try {
    const r = await fetch(master, {
      headers: { "User-Agent": MOBILE_UA, "Referer": STREAMHLS_REFERER, "Origin": "https://streamhls.to" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return jsonError(`upstream ${r.status}`, 502);
    const text = await r.text();
    return cors(rewriteM3u8(text, master, selfBase, STREAMHLS_REFERER), {
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache" },
    });
  } catch (e) {
    return jsonError(String(e), 502);
  }
}

// GET /hls?u=<abs>&r=<referer> → proxy a variant playlist (rewritten) or a
// segment (streamed).
async function handleHls(rawUrl: string, referer: string, selfBase: string): Promise<Response> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return jsonError("invalid url", 400);
  }
  if (!hlsHostAllowed(u.hostname)) return jsonError("host not allowed", 403);
  try {
    const r = await fetch(rawUrl, {
      headers: { "User-Agent": MOBILE_UA, "Referer": referer || STREAMHLS_REFERER, "Origin": new URL(referer || STREAMHLS_REFERER).origin },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return new Response(`upstream ${r.status}`, { status: r.status, headers: { "Access-Control-Allow-Origin": "*" } });
    const ct = r.headers.get("Content-Type") || "";
    const isPlaylist = rawUrl.includes(".m3u8") || ct.includes("mpegurl");
    if (isPlaylist) {
      const text = await r.text();
      return cors(rewriteM3u8(text, rawUrl, selfBase, referer || STREAMHLS_REFERER), {
        headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache" },
      });
    }
    // segment — stream bytes through
    return new Response(r.body, {
      headers: {
        "Content-Type": ct || "video/MP2T",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (e) {
    return new Response(String(e), { status: 502, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return cors(null, { status: 204 });
  const url = new URL(req.url);
  const selfBase = url.origin;

  if (url.pathname === "/savefiles") {
    return handleSavefiles((url.searchParams.get("code") || "").trim(), selfBase);
  }
  if (url.pathname === "/hls") {
    return handleHls(url.searchParams.get("u") || "", url.searchParams.get("r") || "", selfBase);
  }
  // /fetch (or anything with ?url=) — latanime HTML relay
  const target = url.searchParams.get("url");
  if (!target) {
    return cors(JSON.stringify({ ok: true, usage: "/fetch?url=… | /savefiles?code=… | /hls?u=…&r=…" }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return handleFetch(target);
}

Deno.serve(handler);
