// Residential companion — the "app half" of the split. Two jobs:
//
//   GET /aon?url=…     AnimeOnline Ninja HTML/JSON (see below)
//   GET /embed?url=…   ANY browser-gated video host → its real media URL
//
// AnimeOnline Ninja (ww3.animeonline.ninja) gates on IP reputation + a
// Cloudflare managed JS challenge. No datacenter egress clears it — not the
// hosted Worker, not the Deno relay, not Cloudflare's own Browser Rendering
// (all verified stuck on the "Just a moment…" interstitial). The one client AON
// lets through is a real browser on a *residential* IP: your own connection.
//
// The same is true of most of the players the sources embed, for the same
// reasons plus a few new ones — verified 2026-07 from a datacenter IP:
//   • dsvplay.com  → Cloudflare managed challenge ("Just a moment…")
//   • voe.sx       → DDoS-Guard JS challenge
//   • bysekoze.com → Vite SPA whose API needs a proof-of-work *and* a browser
//                    fingerprint (canvas/audio/WebGL/font hashes + an ECDSA
//                    device attestation). Not forgeable outside a browser.
//   • mixdrop.*    → serves fine, but no longer ships MDCore.wurl in a packer
//                    block, and mints its delivery URL bound to the viewer's IP
// Every one of those is a browser-on-a-residential-IP problem, which is exactly
// what this process already is. So rather than write (and endlessly re-fix) a
// manual extractor per host, /embed drives the real browser at the embed page
// and sniffs the network for the media URL the player itself requests. New
// hosts usually need nothing but an entry in EMBED_HOSTS.
//
// Because the URL is minted here, on your residential IP, and Stremio plays it
// from that same IP, IP-bound signed URLs simply work — no proxying, no relay.
// The Worker attaches the Referer via the stream's behaviorHints.proxyHeaders
// so Stremio's local streaming server replays the request exactly as we made it.
//
// This tiny server runs on your machine, drives a real (headless) browser to
// fetch AON pages/API from your residential IP, and holds the cf_clearance
// cookie so the challenge is solved once and reused. The hosted Worker forwards
// every `aon:` fetch here (set AON_COMPANION_URL to this server's public URL),
// parses what comes back, and serves it to Stremio like any other source.
//
// Run:
//   npm install          # in this companion/ dir (pulls Playwright)
//   npx playwright install chromium
//   node aon-resolver.mjs
// Then expose it to the Worker with a tunnel, e.g.:
//   cloudflared tunnel --url http://localhost:8787
// and set the Worker var:  AON_COMPANION_URL = https://<your-tunnel>.trycloudflare.com
//
// Lightweight mode (no browser): if Playwright isn't installed, it falls back to
// plain fetch. That only clears AON if you also supply a cf_clearance cookie
// captured from your browser (same residential IP + UA):
//   AON_COOKIE="cf_clearance=…" AON_UA="<your browser UA>" node aon-resolver.mjs
// /embed has no such fallback — sniffing the player's own network traffic needs
// a real browser, so without Playwright it returns 503 and the Worker keeps
// surfacing those hosts as externalUrl links.

import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const AON_HOST = /(^|\.)animeonline\.ninja$/i; // allowlist — /aon is AON-only
const UA = process.env.AON_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const NAV_TIMEOUT = Number(process.env.AON_NAV_TIMEOUT || 30000);
const EMBED_TIMEOUT = Number(process.env.EMBED_TIMEOUT || 25000);
// How many embed pages may drive the browser at once. The Worker fires a whole
// episode's hosts in parallel; without a cap that's 6-8 simultaneous Chromium
// pages on a home machine.
const EMBED_CONCURRENCY = Number(process.env.EMBED_CONCURRENCY || 3);
const EMBED_CACHE_MS = Number(process.env.EMBED_CACHE_MS || 20 * 60 * 1000);

// Hosts /embed will drive the browser at. This is an allowlist on purpose:
// the endpoint is reachable through your public tunnel, and without it anyone
// who found the URL could point your browser, on your home network, at anything.
// Adding a host is the whole cost of supporting a new player.
const EMBED_HOSTS =
  /(^|\.)(dsvplay\.com|bysekoze\.com|voe\.sx|voe-un-block\.com|voeun-block\.net|v-o-e-unblock\.com|mi+xdrop\.[a-z]{2,6}|streamtape\.[a-z.]{2,10}|stape\.fun|tapewithadblock\.org|uqload\.[a-z.]{2,10}|ok\.ru|odnoklassniki\.ru|filemoon\.[a-z.]{2,10}|vidhide[a-z]*\.com|streamwish\.[a-z]{2,6}|embedwish\.com|wishfast\.top|sfastwish\.com|swishsrv\.com|savefiles\.com|streamhls\.to|hexload\.com|mp4upload\.com|upnshare\.com|zilla-?[a-z]*\.[a-z]{2,6}|doodstream\.com|dood\.[a-z]{2,6}|d0*[0-9]*d\.com)$/i;

// Ad / analytics / popunder noise these players ship. Aborting it makes the
// resolve several seconds faster and keeps the sniffer's signal clean.
const AD_HOSTS =
  /(googlesyndication|doubleclick|google-analytics|googletagmanager|recaptcha|gstatic|adsterra|propellerads|hai8g|eerfumerel|mdstats|greatdexchange|xadsmart|popads|popcash|onclickads|exoclick|juicyads|trafficjunky)\./i;

function isChallenge(body) {
  return /<title>Just a moment|_cf_chl_opt|__cf_chl_|challenge-platform|cf-browser-verification/i.test(body);
}
function allowed(target) {
  try { const u = new URL(target); return u.protocol === "https:" && AON_HOST.test(u.hostname); }
  catch { return false; }
}
function embedAllowed(target) {
  try { const u = new URL(target); return u.protocol === "https:" && EMBED_HOSTS.test(u.hostname); }
  catch { return false; }
}

// ── Browser backend (preferred): a persistent context that keeps cf_clearance ──
let browserCtx = null;
let playwright = null;
async function getContext() {
  if (browserCtx) return browserCtx;
  if (playwright === null) {
    try { playwright = (await import("playwright")).chromium; }
    catch { playwright = false; }
  }
  if (!playwright) return null;
  // CHROME_PATH points Playwright at a browser you already have (system Chrome/
  // Chromium, or a prebuilt one) instead of the versioned download it manages.
  // Useful on a machine that already ships one, and the escape hatch when
  // `npx playwright install` and the installed playwright disagree on builds.
  const executablePath = (process.env.CHROME_PATH || "").trim() || undefined;
  const browser = await playwright.launch({ headless: true, executablePath });
  browserCtx = await browser.newContext({ userAgent: UA, locale: "es-MX" });
  return browserCtx;
}

async function fetchViaBrowser(target) {
  const ctx = await getContext();
  if (!ctx) return null;
  const page = await ctx.newPage();
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    // Give the managed challenge time to run its JS and redirect to real content.
    // Poll for up to NAV_TIMEOUT until the interstitial is gone.
    const deadline = Date.now() + NAV_TIMEOUT;
    let body = await page.content();
    while (isChallenge(body) && Date.now() < deadline) {
      await page.waitForTimeout(1500);
      body = await page.content();
    }
    // JSON REST endpoints render inside a <pre>; hand back the raw text.
    if (/\/wp-json\//i.test(target)) {
      const pre = await page.evaluate(() => document.querySelector("pre")?.textContent || null);
      if (pre) return pre;
    }
    return body;
  } finally {
    await page.close().catch(() => {});
  }
}

// ── /embed backend: sniff the player's own network traffic ────────────────────
// Rather than parse each host's markup, let the page do the work and watch what
// it asks for. A player that plays a video must, at some point, request the
// media — so the first .m3u8 (or .mp4) it fetches IS the answer, whatever the
// obfuscation upstream. That is why this survives host changes that break
// regex extractors.

// In-memory cache. Worth having twice over: the Worker's own KV cache only
// fills once the Worker actually receives an answer, and its request budget is
// far shorter than a cold browser resolve. When the Worker gives up early the
// resolve keeps running here and lands in this cache, so the retry a few
// seconds later is instant. Signed media URLs expire, hence the TTL.
const embedCache = new Map(); // url → { at, value }
let inFlight = 0;
const waiters = [];
async function acquire() {
  if (inFlight < EMBED_CONCURRENCY) { inFlight++; return; }
  await new Promise((r) => waiters.push(r));
  inFlight++;
}
function release() {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

async function sniffEmbed(target, referer) {
  const ctx = await getContext();
  if (!ctx) return null;
  const page = await ctx.newPage();
  // These hosts monetise with popunders; each click can spawn a tab.
  page.on("popup", (p) => p.close().catch(() => {}));

  let hls = null;
  let mp4 = null;
  const note = (u, ct = "") => {
    if (!/^https?:/i.test(u)) return;
    if (!hls && (/\.m3u8(\?|$|#)/i.test(u) || /mpegurl/i.test(ct))) hls = u;
    else if (!mp4 && (/\.mp4(\?|$|#)/i.test(u) || /^video\/mp4/i.test(ct))) mp4 = u;
  };

  try {
    await page.route("**/*", (route) => {
      const req = route.request();
      const u = req.url();
      const type = req.resourceType();
      note(u);
      // The URL is all we need — never pull the actual video bytes down the
      // home connection. Segments and <video> media requests are aborted the
      // moment they're recorded; playlists and scripts still load so the player
      // keeps progressing to the next request.
      if (type === "media" || type === "image" || type === "font") return route.abort();
      // Video by URL as well as by resource type: a preroll ad pulled with
      // fetch() reports as "fetch", not "media", and would otherwise transfer in
      // full down a home connection. Playlists are exempt — the player has to
      // read a master to go on and request the variant we actually want.
      if (/\.(ts|m4s|mp4)(\?|$|#)/i.test(u)) return route.abort();
      if (AD_HOSTS.test(u)) return route.abort();
      return route.continue();
    });
    page.on("response", (r) => note(r.url(), r.headers()["content-type"] || ""));

    await page.goto(target, { referer, waitUntil: "domcontentloaded", timeout: EMBED_TIMEOUT });

    // Most embeds only fetch the media after a user gesture, and a Cloudflare /
    // DDoS-Guard interstitial has to clear before the player even mounts. Poll,
    // clicking the middle of the viewport periodically to stand in for the play
    // button (Playwright clicks are real input events, so they count as a
    // gesture; a synthetic .click() would not).
    const deadline = Date.now() + EMBED_TIMEOUT;
    while (!hls && !mp4 && Date.now() < deadline) {
      const box = page.viewportSize();
      if (box) await page.mouse.click(box.width / 2, box.height / 2).catch(() => {});
      await page.waitForTimeout(1200);
    }
    // An ad's .mp4 can land before the real stream. Once anything is seen, give
    // an m3u8 a moment to overtake it — HLS is the real source on every host
    // here that has one.
    if (mp4 && !hls) {
      const grace = Date.now() + 2500;
      while (!hls && Date.now() < grace) await page.waitForTimeout(300);
    }
    if (!hls && !mp4) {
      // Some players set the src directly instead of fetching it.
      const src = await page
        .evaluate(() => document.querySelector("video")?.currentSrc || document.querySelector("video")?.src || null)
        .catch(() => null);
      if (src) note(src);
    }
    const url = hls || mp4;
    return url ? { url, isHls: !!hls, referer: target, ua: UA } : null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function resolveEmbed(target, referer) {
  const hit = embedCache.get(target);
  if (hit && Date.now() - hit.at < EMBED_CACHE_MS) return hit.value;
  await acquire();
  try {
    const again = embedCache.get(target);
    if (again && Date.now() - again.at < EMBED_CACHE_MS) return again.value;
    const value = await sniffEmbed(target, referer);
    embedCache.set(target, { at: Date.now(), value });
    return value;
  } finally {
    release();
  }
}

// ── Fallback backend: plain fetch + a user-supplied cf_clearance cookie ────────
async function fetchViaCookie(target) {
  const cookie = (process.env.AON_COOKIE || "").trim();
  const headers = { "User-Agent": UA, "Accept": "text/html,application/json,*/*", "Accept-Language": "es-MX,es;q=0.9" };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(target, { headers, signal: AbortSignal.timeout(NAV_TIMEOUT) });
  const body = await r.text();
  return body;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (status, body, type = "text/plain") =>
    res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*" }).end(body);

  if (url.pathname === "/health") {
    return send(200, JSON.stringify({
      ok: true,
      backend: browserCtx ? "browser" : (playwright === false ? "cookie-fetch" : "browser(lazy)"),
      ua: UA,
      embed: playwright === false ? "unavailable (needs Playwright)" : "available",
      embedCached: embedCache.size,
    }), "application/json");
  }

  if (url.pathname === "/embed") {
    const target = url.searchParams.get("url");
    if (!target || !embedAllowed(target)) return send(400, "bad or non-allowlisted embed url");
    const ref = url.searchParams.get("ref") || undefined;
    const t0 = Date.now();
    try {
      const media = await resolveEmbed(target, ref);
      if (!media) {
        console.warn(`[embed] no media found (${Date.now() - t0}ms) ${target}`);
        return send(404, JSON.stringify({ error: "no media url observed" }), "application/json");
      }
      console.log(`[embed] ok ${media.isHls ? "hls" : "mp4"} (${Date.now() - t0}ms) ${target}`);
      return send(200, JSON.stringify(media), "application/json");
    } catch (e) {
      console.error(`[embed] error ${target}: ${e}`);
      // Playwright missing entirely is a setup problem, not a dead host — say so
      // distinctly so the Worker can tell "can't" from "didn't".
      if (playwright === false) return send(503, JSON.stringify({ error: "no browser backend" }), "application/json");
      return send(502, JSON.stringify({ error: String(e) }), "application/json");
    }
  }

  if (url.pathname !== "/aon") return send(404, "not found");

  const target = url.searchParams.get("url");
  if (!target || !allowed(target)) return send(400, "bad or non-AON url");

  try {
    let body = await fetchViaBrowser(target);
    if (body == null) body = await fetchViaCookie(target);
    if (isChallenge(body)) {
      console.warn(`[aon] challenge NOT cleared for ${target}`);
      return send(502, "challenge not cleared — check residential IP / install Playwright / supply AON_COOKIE");
    }
    console.log(`[aon] ok (${body.length}b) ${target}`);
    return send(200, body, /\/wp-json\//i.test(target) ? "application/json" : "text/html");
  } catch (e) {
    console.error(`[aon] error ${target}: ${e}`);
    return send(502, `resolver error: ${e}`);
  }
});

server.listen(PORT, () => {
  console.log(`Residential companion on http://localhost:${PORT}`);
  console.log(`  health: http://localhost:${PORT}/health`);
  console.log(`  fetch : http://localhost:${PORT}/aon?url=https://ww3.animeonline.ninja/`);
  console.log(`  embed : http://localhost:${PORT}/embed?url=https://voe.sx/e/XXXXXXXX`);
  console.log(`Expose with a tunnel, then set the Worker var AON_COMPANION_URL to the public URL.`);
});
