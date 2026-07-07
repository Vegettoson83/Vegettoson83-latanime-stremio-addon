// Latanime HTML fetch proxy for Deno Deploy.
//
// latanime.org is behind Cloudflare and blocks Cloudflare Worker egress at the
// network level, so the Worker (src/index.ts) can't fetch it directly. This
// relays the HTML from Deno Deploy's egress, which isn't caught by that block.
// It runs on always-warm edge isolates — no scale-to-zero cold starts, so
// latency stays flat (~1s per latanime fetch).
//
// Not an open relay: it only proxies https://latanime.org (and subdomains).
//
// Deploy: create a Deno Deploy project linked to this repo with entry point
// `deno/fetch.ts` (or paste this file into a Deno Deploy playground). Then set
// the Worker's FETCH_PROXY_URL in wrangler.toml to:
//     https://<your-project>.deno.dev/fetch

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return cors(null, { status: 204 });

  const { searchParams } = new URL(req.url);
  const target = searchParams.get("url");
  if (!target) {
    return cors(JSON.stringify({ ok: true, usage: "/fetch?url=https://latanime.org/..." }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return jsonError("invalid url", 400);
  }
  // Allowlist: latanime.org and its subdomains only — not a general relay.
  if (u.protocol !== "https:" || !/(^|\.)latanime\.org$/i.test(u.hostname)) {
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
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (e) {
    return jsonError(String(e), 502);
  }
}

Deno.serve(handler);
