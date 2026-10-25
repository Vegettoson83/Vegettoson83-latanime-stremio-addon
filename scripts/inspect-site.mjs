#!/usr/bin/env node
// Verifies that latanime.org still matches the parsing assumptions in src/index.ts.
// Run from any machine with open internet:  node scripts/inspect-site.mjs
// Exit code 0 = all checks pass, 1 = at least one assumption broke.

const BASE_URL = "https://latanime.org";

const CHROME_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7",
  Referer: "https://www.google.com/",
};

let failures = 0;

function check(name, ok, detail = "") {
  const mark = ok ? "✅" : "❌";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
}

async function fetchHtml(url) {
  const r = await fetch(url, { headers: CHROME_HEADERS, redirect: "follow" });
  const html = await r.text();
  console.log(`\n── GET ${url} → HTTP ${r.status}, ${html.length} bytes`);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  if (html.length < 500) throw new Error(`Suspiciously short response (${html.length}b) for ${url}`);
  return html;
}

// Mirrors parseAnimeCards() in src/index.ts
function parseAnimeCards(html) {
  const results = [];
  const seen = new Set();
  for (const m of html.matchAll(/href=["'](?:https?:\/\/latanime\.org)?\/anime\/([a-z0-9][a-z0-9-]+)["']/gi)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const pos = m.index + m[0].length;
    const block = html.slice(pos, pos + 600);
    const titleM =
      block.match(/<h3[^>]*>([^<]{3,})<\/h3>/i) ||
      block.match(/alt="([^"]{3,})"/) ||
      block.match(/title="([^"]{3,})"/);
    const name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : slug;
    const posterM =
      block.match(/data-src="(https?:\/\/latanime\.org\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      block.match(/data-src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      block.match(/src="(https?:\/\/latanime\.org\/(?:thumbs|assets)\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/);
    results.push({ slug, name, hasTitle: !!titleM, hasPoster: !!posterM });
  }
  return results;
}

function summarizeCards(label, cards) {
  const withTitle = cards.filter((c) => c.hasTitle).length;
  const withPoster = cards.filter((c) => c.hasPoster).length;
  check(`${label}: anime card links found`, cards.length > 0, `${cards.length} cards`);
  check(`${label}: titles resolve (h3/alt/title)`, cards.length > 0 && withTitle >= cards.length * 0.8, `${withTitle}/${cards.length}`);
  check(`${label}: posters resolve (data-src/src)`, cards.length > 0 && withPoster >= cards.length * 0.5, `${withPoster}/${cards.length}`);
  if (cards[0]) console.log(`   sample: ${cards[0].slug} → "${cards[0].name}"`);
}

async function main() {
  // 1. Home page (latest catalog)
  const home = await fetchHtml(`${BASE_URL}/`);
  const homeCards = parseAnimeCards(home);
  summarizeCards("home", homeCards);
  const csrfM =
    home.match(/name="csrf-token"[^>]+content="([^"]+)"/i) ||
    home.match(/content="([^"]+)"[^>]+name="csrf-token"/i);
  check("home: csrf-token meta tag present (needed for /buscar_ajax)", !!csrfM);

  // 2. En Emisión catalog
  const emision = await fetchHtml(`${BASE_URL}/emision`);
  summarizeCards("emision", parseAnimeCards(emision));

  // 3. Directory with pagination
  const dir = await fetchHtml(`${BASE_URL}/animes?page=1`);
  summarizeCards("directory p1", parseAnimeCards(dir));

  // 4. Anime detail page (meta)
  const slug = homeCards[0]?.slug;
  if (!check("picked a slug from home page for deep checks", !!slug)) return;
  const detail = await fetchHtml(`${BASE_URL}/anime/${slug}`);
  check("detail: <h2> title present", /<h2[^>]*>[\s\S]*?<\/h2>/i.test(detail));
  check("detail: og:image meta present", /property="og:image"/i.test(detail));
  check("detail: genre links (/genero/) present", /href="[^"]*\/genero\//i.test(detail));
  const epMatches = [...detail.matchAll(/href=["'](?:https?:\/\/latanime\.org)?\/ver\/([a-z0-9-]+-episodio-(\d+(?:\.\d+)?))["']/gi)];
  check("detail: episode links (/ver/…-episodio-N) present", epMatches.length > 0, `${epMatches.length} episodes`);

  // 5. Episode page (streams)
  const epPath = epMatches[0]?.[1];
  if (!check("picked an episode for player checks", !!epPath)) return;
  const ep = await fetchHtml(`${BASE_URL}/ver/${epPath}`);

  const keyM = ep.match(/data-key="([A-Za-z0-9+/=]+)"/);
  let baseUrl = "";
  if (keyM) { try { baseUrl = atob(keyM[1]); } catch {} }
  check("episode: data-key attribute present", !!keyM, keyM ? `decodes to "${baseUrl}"` : "");
  check("episode: data-key decodes to a URL prefix", baseUrl.startsWith("http") || baseUrl.startsWith("//"), baseUrl);

  const players = [...ep.matchAll(/<a[^>]+data-player="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({
    suffix: m[1].trim(),
    name: m[2].replace(/<[^>]+>/g, "").trim() || "Player",
  }));
  check("episode: data-player anchors present", players.length > 0, `${players.length} players`);
  for (const p of players) {
    let url;
    if (p.name.toLowerCase().includes("yourupload")) {
      try { url = atob(p.suffix); } catch { url = "(base64 decode failed)"; }
    } else if (/^[A-Za-z0-9+/=]{20,}$/.test(p.suffix)) {
      // Heuristic: if the suffix alone base64-decodes to a URL, the site may have
      // reverted to the old full-base64 scheme — flag it.
      let decoded = "";
      try { decoded = atob(p.suffix); } catch {}
      url = decoded.startsWith("http") || decoded.startsWith("//")
        ? `${baseUrl}${p.suffix}  [⚠ suffix ALSO decodes standalone to ${decoded} — scheme may have changed]`
        : baseUrl + p.suffix;
    } else {
      url = baseUrl + p.suffix;
    }
    console.log(`   player "${p.name}" → ${url}`);
  }
  const validEmbeds = players.filter((p) => {
    if (p.name.toLowerCase().includes("yourupload")) {
      try { return atob(p.suffix).startsWith("http"); } catch { return false; }
    }
    const u = baseUrl + p.suffix;
    return u.startsWith("http") || u.startsWith("//");
  });
  check("episode: player URLs resolve via data-key + data-player", validEmbeds.length > 0, `${validEmbeds.length}/${players.length}`);

  // Download mirrors
  const mirrors = {};
  for (const m of ep.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = m[1];
    for (const host of ["mediafire.com", "savefiles.com", "pixeldrain.com", "mega.nz", "gofile.io"]) {
      if (href.includes(host) && !mirrors[host]) mirrors[host] = href;
    }
  }
  console.log(`   mirrors: ${Object.keys(mirrors).join(", ") || "none"}`);
  check("episode: at least one download mirror present", Object.keys(mirrors).length > 0, "(informational — availability varies per episode)");

  // 6. Search endpoint
  if (csrfM) {
    const r = await fetch(`${BASE_URL}/buscar_ajax`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": csrfM[1],
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${BASE_URL}/`,
        Origin: BASE_URL,
        "User-Agent": CHROME_HEADERS["User-Agent"],
      },
      body: JSON.stringify({ q: "naruto" }),
    });
    console.log(`\n── POST ${BASE_URL}/buscar_ajax → HTTP ${r.status}`);
    const searchHtml = r.ok ? await r.text() : "";
    const searchCards = parseAnimeCards(searchHtml);
    check("search: /buscar_ajax returns parseable cards", r.ok && searchCards.length > 0, `HTTP ${r.status}, ${searchCards.length} cards`);
  }

  console.log(`\n${failures === 0 ? "✅ All assumptions hold — no code changes needed." : `❌ ${failures} check(s) failed — src/index.ts needs updating where marked above.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nFatal: ${e.message}`);
  process.exit(1);
});
