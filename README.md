# Latanime Stremio Addon

A Stremio addon for watching anime in Spanish (Latino/Castellano) from latanime.org, running as a Cloudflare Worker.

## Add to Stremio

The deployed addon lives at:

```
https://123456.vegettoson83.workers.dev/manifest.json
```

In Stremio → **Addons** → **Community Addons** → paste the URL → Install 🎉

> The Worker's name in the Cloudflare dashboard is `123456`, which is what
> determines the `workers.dev` URL. If you rename the Worker, the URL changes
> and every existing Stremio install breaks — update `name` in `wrangler.toml`
> and this README together if you ever do.

## How it deploys

There is **no GitHub Actions deploy workflow** — adding one would double-deploy.

- **Worker** (`src/index.ts`): deployed by **Cloudflare Workers Builds** (the
  dashboard Git integration) on every push to `main`.
- **Fetch proxy** (`deno/fetch.ts`): deployed by **Deno Deploy**'s Git
  integration (entrypoint pinned by `deno.json`). latanime.org blocks
  Cloudflare Worker egress, so the Worker relays HTML through this proxy
  (`FETCH_PROXY_URL` in `wrangler.toml`), and savefiles HLS is resolved and
  served entirely from Deno's stable IP.

## Manual deploy (emergency only)

```bash
npm install
npx wrangler login
npx wrangler deploy
```

`name` in `wrangler.toml` must stay `123456` (the live Worker) or this creates
a second Worker at a different URL instead of updating the real one.

## Health checks

- `https://123456.vegettoson83.workers.dev/_health` — version + KV binding
- `https://123456.vegettoson83.workers.dev/debug` — config (proxy, rendering)
- `/debug-extract?id=<slug>:<episode>` — runs every extractor with timings
