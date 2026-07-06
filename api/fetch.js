// Tiny HTML fetch proxy — deployed on Vercel (this repo's existing Vercel
// integration), NOT Cloudflare. latanime.org sits behind Cloudflare and blocks
// Cloudflare Worker egress at the network level, so the Worker can't fetch it
// directly; Vercel's function egress (AWS) isn't caught by that block, so it
// relays the HTML back to the Worker.
//
// The Worker calls this via env FETCH_PROXY_URL (see fetchHtml). It is NOT an
// open relay: it only proxies latanime.org, so it can't be abused to fetch
// arbitrary hosts.

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

  const target = typeof req.query.url === "string" ? req.query.url : "";
  if (!target) return res.status(400).json({ error: "missing ?url=" });

  let u;
  try {
    u = new URL(target);
  } catch {
    return res.status(400).json({ error: "invalid url" });
  }
  // Allowlist: latanime.org and its subdomains only — keeps this from being a
  // general-purpose open proxy.
  if (!/(^|\.)latanime\.org$/i.test(u.hostname) || u.protocol !== "https:") {
    return res.status(403).json({ error: "host not allowed" });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    const upstream = await fetch(target, {
      headers: {
        "User-Agent": CHROME_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: "https://www.google.com/",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await upstream.text();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    // Short edge cache so repeated Worker calls for the same page are cheap.
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(upstream.status).send(body);
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
}
