# latanime fetch proxy — Deno Deploy

`fetch.ts` is a tiny HTML fetch proxy for the Worker. latanime.org blocks
Cloudflare Worker egress, so the Worker relays page fetches through this
service, which runs on Deno Deploy's non-Cloudflare, always-warm edge (no
scale-to-zero cold starts). It only proxies `latanime.org`.

## Deploy (GitHub integration — recommended)

1. Go to <https://dash.deno.com> → **New Project** → link this GitHub repo.
2. Set the **entry point** to `deno/fetch.ts`. No build step, no env vars.
3. Deploy. You'll get a URL like `https://<project>.deno.dev`.
4. Sanity check: open
   `https://<project>.deno.dev/fetch?url=https://latanime.org/` — it should
   return latanime's HTML.
5. Point the Worker at it: set `FETCH_PROXY_URL` in `../wrangler.toml` to
   `https://<project>.deno.dev/fetch` and push (the Worker redeploys).

Alternatively, paste `fetch.ts` into a **Deno Deploy playground** for a
zero-repo setup, or use `deployctl deploy --entrypoint deno/fetch.ts`.

## Notes

- Deno Deploy's free tier is generous (well beyond a personal addon's traffic)
  and doesn't sleep, so latency stays flat — unlike the Vercel function
  (`../api/fetch.js`), which cold-starts.
- Once `FETCH_PROXY_URL` points here, `../api/fetch.js` can be removed.
