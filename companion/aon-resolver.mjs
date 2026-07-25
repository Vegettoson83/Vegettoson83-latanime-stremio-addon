// AON residential resolver — the "app half" of the split.
//
// AnimeOnline Ninja (ww3.animeonline.ninja) gates on IP reputation + a
// Cloudflare managed JS challenge. No datacenter egress clears it — not the
// hosted Worker, not the Deno relay, not Cloudflare's own Browser Rendering
// (all verified stuck on the "Just a moment…" interstitial). The one client AON
// lets through is a real browser on a *residential* IP: your own connection.
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

import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const AON_HOST = /(^|\.)animeonline\.ninja$/i; // allowlist — this proxy is AON-only
const UA = process.env.AON_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const NAV_TIMEOUT = Number(process.env.AON_NAV_TIMEOUT || 30000);
// Keep-warm: re-navigate to AON this often so the cf_clearance the persistent
// context holds never goes cold. 0 disables it. Default 20 min sits under the
// typical cf_clearance lifetime (~30 min–hours), so a real request never pays
// the 5–15s challenge-solve — the browser has already solved it in the
// background. Set AON_WARM_URL to change the page it warms (default: AON root).
const WARM_MS = Number(process.env.AON_WARM_MS ?? 20 * 60 * 1000);
const WARM_URL = process.env.AON_WARM_URL || "https://ww3.animeonline.ninja/";

function isChallenge(body) {
  return /<title>Just a moment|_cf_chl_opt|__cf_chl_|challenge-platform|cf-browser-verification/i.test(body);
}
function allowed(target) {
  try { const u = new URL(target); return u.protocol === "https:" && AON_HOST.test(u.hostname); }
  catch { return false; }
}

// ── Browser backend (preferred): a persistent context that keeps cf_clearance ──
// The context is cached and reused so the challenge is solved once. If the
// browser process ever dies (crash, OOM, machine sleep), the cached handles go
// stale; we listen for 'disconnected' and null them out so the next call
// transparently relaunches instead of failing every request until a manual
// restart.
let browser = null;
let browserCtx = null;
let playwright = null;
async function getContext() {
  if (browserCtx) return browserCtx;
  if (playwright === null) {
    try { playwright = (await import("playwright")).chromium; }
    catch { playwright = false; }
  }
  if (!playwright) return null;
  browser = await playwright.launch({ headless: true });
  browser.on("disconnected", () => {
    if (browserCtx) console.warn("[aon] browser disconnected — will relaunch on next request");
    browser = null;
    browserCtx = null;
  });
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
      keepWarmMs: WARM_MS,
      warming,
    }), "application/json");
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

// ── Keep-warm: hold cf_clearance fresh in the background ───────────────────────
// Re-navigates the persistent context to AON on a timer so the challenge is
// (re)solved before a real request ever needs it. Serialized via `warming` so a
// slow solve can't stack overlapping navigations. Silent no-op when Playwright
// isn't installed (cookie-fetch mode has no context to warm).
let warming = false;
async function warm(reason) {
  if (warming) return;
  warming = true;
  try {
    const body = await fetchViaBrowser(WARM_URL);
    if (body == null) return; // no browser backend — nothing to warm
    console.log(`[aon] warm (${reason}): ${isChallenge(body) ? "challenge still up" : `cleared, ${body.length}b`}`);
  } catch (e) {
    console.warn(`[aon] warm (${reason}) failed: ${e}`);
  } finally {
    warming = false;
  }
}

server.listen(PORT, () => {
  console.log(`AON residential resolver on http://localhost:${PORT}`);
  console.log(`  health: http://localhost:${PORT}/health`);
  console.log(`  fetch : http://localhost:${PORT}/aon?url=https://ww3.animeonline.ninja/`);
  console.log(`Expose with a tunnel, then set the Worker var AON_COMPANION_URL to the public URL.`);
  // Warm on startup so the first real request skips the solve, then on a timer.
  warm("startup");
  if (WARM_MS > 0) setInterval(() => warm("timer"), WARM_MS).unref();
});
