# AON residential resolver (the "app half")

AnimeOnline Ninja gates on **IP reputation + a Cloudflare managed JS challenge**.
No datacenter egress the addon has clears it — not the hosted Cloudflare Worker,
not the Deno relay, not Cloudflare's own Browser Rendering (all verified stuck on
the "Just a moment…" interstitial). The only client AON lets through is a **real
browser on a residential IP** — i.e. your own connection.

This little server is that residential half. It runs on your machine, drives a
real (headless) browser to fetch AON from your IP, and holds the `cf_clearance`
cookie so the challenge is solved once and reused. The hosted Worker forwards
every `aon:` fetch here and parses what comes back — so AON shows up in Stremio
like any other source, but the actual fetching happens on *your* connection.

```
  Stremio ── https ──> hosted Worker ── forwards aon: ──> THIS (your PC) ── residential ──> AON
```

## Run it

```bash
cd companion
npm install
npx playwright install chromium
npm start            # listens on http://localhost:8787
```

Check it works from your own IP:

```bash
curl "http://localhost:8787/health"
curl "http://localhost:8787/aon?url=https://ww3.animeonline.ninja/wp-json/dooplay/search?keyword=naruto"
```

If that second call returns JSON (not "Just a moment…"), your residential IP
clears the challenge and you're good.

## Connect it to the hosted Worker

The Worker (in the cloud) can't reach `localhost`, so expose this server with a
tunnel:

```bash
cloudflared tunnel --url http://localhost:8787
# → https://<random>.trycloudflare.com
```

Then set the Worker variable (Cloudflare dashboard → Worker → Settings →
Variables, or `wrangler secret`):

```
AON_COMPANION_URL = https://<your-tunnel>.trycloudflare.com
```

Confirm with `https://<your-worker>/debug` → `aonCompanion` should show the URL.
Now search **Anime Online Ninja** in Stremio: the Worker forwards each fetch to
your resolver, and streams resolve from your IP.

## Lightweight mode (no browser)

If you don't want to install Playwright, the resolver falls back to plain
`fetch`. That only clears AON if you paste a `cf_clearance` cookie captured from
your browser (same residential IP + user-agent):

```bash
AON_COOKIE="cf_clearance=…" \
AON_UA="<your exact browser User-Agent>" \
node aon-resolver.mjs
```

The cookie expires (~30 min–hours) and must be re-pasted; the Playwright backend
refreshes it automatically, so the browser mode is recommended for anything but a
quick test.

## Notes

- The resolver is **AON-only** (hostname allowlist) — it won't proxy anything
  else, so it can't be turned into an open proxy.
- It only does anything when *you* run it and set `AON_COMPANION_URL`; with the
  var unset the hosted addon is completely unchanged for everyone.
- Keep it running while you watch. Stop it and AON simply stops resolving (the
  other sources are unaffected).
