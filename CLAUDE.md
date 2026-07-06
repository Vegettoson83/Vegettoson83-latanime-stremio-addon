# Latanime Stremio Addon

Cloudflare Worker serving the Stremio addon protocol for latanime.org. Single
source file: `src/index.ts`. Deployed by `.github/workflows/deploy.yml` on every
push to `main` — there is no test suite; `npx tsc --noEmit` is the only gate.

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
- **No server-side browser**: stream extraction is manual only — direct HTTP
  fetch plus parsing/unpacking inside the Worker. There is no headless-browser
  bridge. A host that can't be resolved manually is surfaced as an
  `externalUrl` (opens in the user's own client), never rendered server-side.

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

- One deploy workflow (`deploy.yml`). Never add a second workflow that
  triggers on push to `main`.
- No committed backup files (`*.bak`); git history is the backup.
- Remove superseded code when replacing it — dead extractors and unused env
  vars are noise, not safety nets.
- Bump `MANIFEST.version` on user-visible changes.
