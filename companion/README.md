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

## Run it on your phone (Termux)

The companion is just a Node script + a real browser, so it can run on your
Android phone — the most hyper-local residential IP you have. The catch:
**Playwright's downloaded Chromium is built for glibc and will not run on
Termux's Bionic libc.** Don't `playwright install chromium` on Termux and expect
it to work. Two paths that do:

**A) proot Ubuntu (most reliable)** — a glibc userland inside Termux, where the
normal install works:

```bash
pkg install proot-distro
proot-distro install ubuntu
proot-distro login ubuntu
# now inside Ubuntu:
apt install -y nodejs npm
cd companion && npm install && npx playwright install --with-deps chromium
npm start
```

**B) Termux-native Chromium** — use the Chromium that *is* built for Termux and
point the companion at it:

```bash
pkg install nodejs chromium
cd companion && npm install
AON_CHROMIUM_PATH=$PREFIX/bin/chromium-browser npm start
```

If a challenge won't clear headlessly, solve it on-screen once with
[Termux:X11 ↗](https://github.com/termux/termux-x11) and `AON_HEADFUL=1` — a real
Chromium window opens, you (or its own JS) clear the challenge, and the
persistent context reuses that clearance headlessly afterward:

```bash
AON_HEADFUL=1 AON_CHROMIUM_PATH=$PREFIX/bin/chromium-browser npm start
```

Then point your TV's Stremio directly at the phone on your LAN
(`http://<phone-ip>:8787/…`) — no tunnel needed when they share a network.
(Note: this serves the `aon:` fetch path; a full all-sources addon on the phone
is a larger port of the hosted Worker, not just this resolver.)

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

## Self-healing (browser mode)

The Playwright backend keeps itself ready without intervention:

- **Crash recovery** — if the headless browser dies (crash, OOM, the machine
  sleeping), the resolver notices the disconnect and relaunches it on the next
  request instead of failing every call until you restart.
- **Keep-warm** — it re-navigates to AON in the background every `AON_WARM_MS`
  (default 20 min, under the typical `cf_clearance` lifetime), so the challenge
  is re-solved *before* a real request needs it. Playback never waits on the
  5–15s solve. Set `AON_WARM_MS=0` to disable, or `AON_WARM_URL` to warm a
  specific page. `/health` reports `keepWarmMs` and whether a warm is in flight.

## Notes

- The resolver is **AON-only** (hostname allowlist) — it won't proxy anything
  else, so it can't be turned into an open proxy.
- It only does anything when *you* run it and set `AON_COMPANION_URL`; with the
  var unset the hosted addon is completely unchanged for everyone.
- Keep it running while you watch. Stop it and AON simply stops resolving (the
  other sources are unaffected).
