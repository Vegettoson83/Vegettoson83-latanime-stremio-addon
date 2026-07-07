# Latanime Stremio Addon

Cloudflare Worker serving the Stremio addon protocol for latanime.org. Main
source file: `src/index.ts`, plus two interchangeable non-Cloudflare HTML fetch
proxies — `deno/fetch.ts` (Deno Deploy, preferred) and `api/fetch.js` (Vercel)
— see the fetch-proxy note below. The Worker is deployed by **Cloudflare Workers
Builds** (the dashboard Git integration) on every push to `main`; the proxy
deploys via whichever of Deno Deploy / Vercel you connect. No deploy workflow
lives in the repo, and there is no test suite; `npx tsc --noEmit` (which only
covers `src/`) is the only gate.

## Invariant structure

These are the stable contracts. Changes here are protocol work and must stay
spec-compliant (https://github.com/Stremio/stremio-addon-sdk/tree/master/docs):

- **Routes**: `/manifest.json`, `/catalog/...`, `/meta/...`, `/stream/...`,
  plus `/proxy/m3u8` + `/proxy/seg` (HLS rewriting proxy) and `/debug*`
  endpoints. All JSON responses go through `json()` and carry CORS headers.
- **ID scheme**: `latanime:{slug}` for series, `latanime:{slug}:{episode}` for
  streams. `idPrefixes: ["latanime:"]` in the manifest depends on this.
- **Cache**: KV only (`STREAM_CACHE`), never in-memory state — a module-level
  Map previously grew unbounded and caused 1101 crashes. TTLs live in `TTL`.
- **Time budget**: Worker wall time is 30s; `fetchHtml` holds a hard 25s
  budget. New network calls need an explicit `AbortSignal.timeout`.
- **latanime fetch path**: latanime.org is behind Cloudflare and blocks
  Worker egress at the network level, so direct `fetch` from the Worker is
  unreliable. `fetchHtml` **races** direct against `FETCH_PROXY_URL` (the
  non-Cloudflare proxy — `deno/fetch.ts` or `api/fetch.js`, the reliable path)
  and takes the first valid HTML, then falls back to Browser Rendering (if
  configured) → free CORS proxies (mostly dead). Both proxies allowlist
  latanime.org only — keep it that way.
- **Extraction is manual-first**: direct HTTP fetch plus parsing/unpacking
  inside the Worker — no external headless-browser bridge (the Render bridge
  and `@cloudflare/puppeteer` import both caused outages/1101 crashes and are
  gone). The one optional escalation is **Cloudflare Browser Rendering** via
  the REST `/content` API (`renderPage`), gated on `CF_ACCOUNT_ID` +
  `CF_API_TOKEN`; it renders a page on Cloudflare's edge (no puppeteer import)
  as a fallback for `fetchHtml` when latanime's Cloudflare challenge blocks
  direct egress, and for player hosts that need JS. Unset ⇒ fully manual; a
  host still unresolved is surfaced as an `externalUrl` (opens in the user's
  own client).

## Volatile layer (expected churn)

Everything that touches latanime.org markup or a video host is scrape code and
breaks when upstream changes. When it breaks, fix it in place — don't leave the
old variant behind:

- `parseAnimeCards` / `parseEpisodeCards` / `parseEpisodeEmbeds` — HTML regex
  scraping. `data-player` is base64 of the provider URL (decode-first, see
  comment in `parseEpisodeEmbeds`).
- Per-host extractors (`extractMp4upload`, `extractHexload`,
  `extractSavefiles`, `resolveMediafire`, `extractMixdrop`). Add a new host by
  writing another manual extractor, not by reaching for a browser.
- `unpackPacker` reverses Dean Edwards `eval(function(p,a,c,k,e,d){…})`
  packing — reuse it for any host that ships its config that way.
- `/debug-extract?id=slug:episode` runs every extractor with timings, and
  `/debug-mixdrop?url=` / `/debug-host?url=` probe a single embed — use them
  to diagnose extraction failures on the deployed worker.

## Rules

- One deployer: Cloudflare Workers Builds (dashboard Git integration). Don't
  add a GitHub Actions `wrangler deploy` workflow — it would double-deploy on
  every push to `main`.
- No committed backup files (`*.bak`); git history is the backup.
- Remove superseded code when replacing it — dead extractors and unused env
  vars are noise, not safety nets.
- Bump `MANIFEST.version` on user-visible changes.
