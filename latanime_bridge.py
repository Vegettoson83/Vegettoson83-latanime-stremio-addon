#!/usr/bin/env python3
"""
latanime.org — HTML to JS Bridge Scraper
==========================================
Run this locally. Requires: pip install requests beautifulsoup4 playwright
For Playwright: playwright install chromium

The script runs in two phases:
  Phase 1 — DIAGNOSTIC: Dumps the raw HTML bridge point (script tags, data attrs)
  Phase 2 — EXTRACTION: Uses what was found to extract embed URLs
  Phase 3 — FALLBACK:   If bridge is AJAX, intercepts with Playwright

Usage:
  python latanime_bridge.py                        # Run full diagnostic + extraction
  python latanime_bridge.py --series one-punch-man-temporada-3  # Full series
  python latanime_bridge.py --episode <url>        # Single episode
"""

import re
import json
import time
import sys
import base64
import argparse
import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse

BASE = "https://latanime.org"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "es-419,es;q=0.9,en;q=0.8",
    "Referer": "https://latanime.org/",
}

KNOWN_HOSTS = [
    "filemoon", "voe", "mp4upload", "doodstream", "streamtape",
    "hexload", "lulu", "mxdrop", "dsvplay", "savefiles", "mega",
]

# ─── PHASE 1: DIAGNOSTIC ─────────────────────────────────────────────────────

def diagnose_episode(url):
    """
    Fetch raw HTML and report everything — this is how we discover the bridge.
    Run this first on any episode to understand the architecture.
    """
    print(f"\n{'='*65}")
    print(f"DIAGNOSTIC: {url}")
    print('='*65)

    r = requests.get(url, headers=HEADERS, timeout=15)
    print(f"HTTP {r.status_code} | {len(r.text)} chars")

    soup = BeautifulSoup(r.text, "html.parser")
    raw = r.text

    # 1. Check for data attributes on player buttons
    print("\n[1] DATA ATTRIBUTES on player-related elements:")
    found_data = False
    for attr in ["data-url", "data-embed", "data-src", "data-video", "data-file", "data-player"]:
        els = soup.find_all(attrs={attr: True})
        if els:
            found_data = True
            for el in els:
                print(f"  <{el.name} {attr}='{el[attr]}'> text: {el.get_text(strip=True)[:60]}")
    if not found_data:
        print("  ✗ None found")

    # 2. Dump all <script> tag contents
    print("\n[2] INLINE <script> BLOCKS:")
    scripts = [s for s in soup.find_all("script") if s.string and len(s.string.strip()) > 30]
    if not scripts:
        print("  ✗ No inline scripts with content")
    for i, s in enumerate(scripts):
        content = s.string.strip()
        print(f"\n  [script {i}] ({len(content)} chars):")
        print("  " + content[:800].replace("\n", "\n  "))
        if len(content) > 800:
            print(f"  ... [{len(content) - 800} chars truncated]")

    # 3. Look for external JS files (might contain player logic)
    print("\n[3] EXTERNAL <script> SRC FILES:")
    for s in soup.find_all("script", src=True):
        print(f"  {s['src']}")

    # 4. Raw search for any known host URLs in page
    print(f"\n[4] KNOWN VIDEO HOST URLS anywhere in HTML:")
    for host in KNOWN_HOSTS:
        pattern = rf'https?://[^\s\'"<>]*{host}[^\s\'"<>]+'
        matches = re.findall(pattern, raw, re.IGNORECASE)
        for m in matches:
            print(f"  [{host}] {m}")

    # 5. The player UL element — print its raw HTML
    print("\n[5] PLAYER BUTTON LIST (raw HTML):")
    for ul in soup.find_all("ul"):
        items_text = " ".join(li.get_text(strip=True).lower() for li in ul.find_all("li"))
        if any(h in items_text for h in KNOWN_HOSTS):
            print(f"  {ul}")

    # 6. Any onclick handlers with URLs
    print("\n[6] ONCLICK HANDLERS containing URLs:")
    for el in soup.find_all(onclick=True):
        onclick = el.get("onclick", "")
        if "http" in onclick or "//" in onclick:
            print(f"  <{el.name}> onclick='{onclick[:200]}'")

    # 7. Check around keyword "episod" or "player" in raw HTML for context
    print("\n[7] RAW HTML CONTEXT around 'player' keyword (±300 chars):")
    idx = raw.lower().find("var player")
    if idx == -1:
        idx = raw.lower().find("loadplayer")
    if idx == -1:
        idx = raw.lower().find("setplayer")
    if idx != -1:
        print(raw[max(0, idx-100):idx+300])
    else:
        print("  ✗ No 'player' variable/function found in HTML")

    return r.text


# ─── PHASE 2: EXTRACTION ─────────────────────────────────────────────────────

def extract_players(episode_url):
    """
    Attempt to extract player embed URLs from static HTML using discovered bridge.
    Returns dict of {server_name: embed_url} and {hoster: download_url}.
    """
    r = requests.get(episode_url, headers=HEADERS, timeout=15)
    raw = r.text
    soup = BeautifulSoup(raw, "html.parser")

    players = {}
    downloads = {}
    bridge_method = None

    # Strategy A: data attributes
    for attr in ["data-url", "data-embed", "data-src", "data-video", "data-player"]:
        for el in soup.find_all(attrs={attr: True}):
            val = el[attr]

            # Try to decode base64 if it looks like it
            if attr == "data-player":
                try:
                    # Check if it needs padding
                    padding = len(val) % 4
                    if padding:
                        val += "=" * (4 - padding)
                    decoded = base64.b64decode(val).decode('utf-8')
                    if decoded.startswith('http') or any(h in decoded for h in KNOWN_HOSTS):
                         val = decoded
                except Exception:
                    pass

            if any(h in val for h in KNOWN_HOSTS) or val.startswith("http"):
                # Avoid catching thumbnails
                is_image = any(val.lower().split('?')[0].endswith(ext) for ext in ['.jpg', '.png', '.jpeg', '.webp'])
                if is_image:
                    if attr != "data-player": # Only skip if not explicitly from data-player
                        continue

                server = el.get_text(strip=True).lower().replace(" ", "_") or attr
                players[server] = val
                bridge_method = "data_attributes"

    # Strategy B: inline script JSON/variables
    if not players:
        for script in soup.find_all("script"):
            text = script.string or ""

            # var X = [{server: '...', url: '...'}]
            for pattern in [
                r'(?:var|let|const)\s+\w+\s*=\s*(\[(?:\s*\{[^}]+\}\s*,?\s*)+\])',
                r'(?:var|let|const)\s+\w+\s*=\s*(\{[^;]{20,500}\})',
            ]:
                match = re.search(pattern, text, re.DOTALL)
                if match:
                    try:
                        data = json.loads(match.group(1))
                        if isinstance(data, list):
                            for item in data:
                                s = item.get("server") or item.get("name") or "player"
                                u = item.get("url") or item.get("embed") or item.get("src")
                                if u:
                                    players[s.lower()] = u
                                    bridge_method = "inline_json"
                        elif isinstance(data, dict):
                            for k, v in data.items():
                                if isinstance(v, str) and ("http" in v or "//" in v):
                                    players[k.lower()] = v
                                    bridge_method = "inline_json"
                    except:
                        pass

            # Direct URL extraction from script
            if not players:
                for host in KNOWN_HOSTS:
                    pattern = rf'https?://[^\s\'"<>]*{re.escape(host)}[^\s\'"<>]+'
                    matches = re.findall(pattern, text, re.IGNORECASE)
                    for m in matches:
                        players[host] = m
                        bridge_method = "url_in_script"

    # Strategy C: onclick attributes
    if not players:
        for el in soup.find_all(onclick=True):
            onclick = el.get("onclick", "")
            url_match = re.search(r"['\"]?(https?://[^\s'\"<>]+)['\"]?", onclick)
            if url_match:
                host = urlparse(url_match.group(1)).netloc.split(".")[0]
                players[host] = url_match.group(1)
                bridge_method = "onclick_handler"

    # Download links — always static HTML
    dl_patterns = {
        "pixeldrain": r"pixeldrain\.com/u/\S+",
        "mega": r"mega\.nz/[^\s'\"<>]+",
        "mediafire": r"mediafire\.com/file/[^\s'\"<>]+",
        "gofile": r"gofile\.io/d/[^\s'\"<>]+",
        "savefiles": r"savefiles\.com/[^\s'\"<>]+",
        "1cloudfile": r"1cloudfile\.com/[^\s'\"<>]+",
    }
    for name, pat in dl_patterns.items():
        m = re.search(pat, raw)
        if m:
            val = m.group(0)
            downloads[name] = val if val.startswith("http") else f"https://{val}"

    return {
        "bridge_method": bridge_method or "ajax_required",
        "players": players,
        "downloads": downloads,
    }


# ─── PHASE 3: PLAYWRIGHT FALLBACK ────────────────────────────────────────────

async def extract_players_playwright(episode_url, server="filemoon"):
    """
    Fallback when bridge is AJAX-based.
    Intercepts network requests triggered by clicking a player button.

    Requires: pip install playwright && playwright install chromium
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("Playwright not installed. Run: pip install playwright && playwright install chromium")
        return {}

    captured = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=HEADERS["User-Agent"],
            extra_http_headers={"Accept-Language": HEADERS["Accept-Language"]},
        )
        page = await context.new_page()

        # Intercept all requests and log video-hosting domains
        def on_request(req):
            if any(h in req.url for h in KNOWN_HOSTS):
                captured.append({"url": req.url, "method": req.method, "headers": dict(req.headers)})

        page.on("request", on_request)
        await page.goto(episode_url, wait_until="networkidle")

        # Click the target server button
        try:
            # Try to be more flexible with the selector
            selector = f"li:has-text('{server}'), a:has-text('{server}')"
            await page.wait_for_selector(selector, timeout=5000)
            await page.click(selector)
            await page.wait_for_timeout(5000)
        except Exception as e:
            print(f"Could not click '{server}': {e}")

        # Also grab the iframe src if one loaded
        iframes = await page.query_selector_all("iframe")
        for iframe in iframes:
            src = await iframe.get_attribute("src")
            if src and any(h in src for h in KNOWN_HOSTS):
                captured.append({"url": src, "method": "iframe_src"})

        await browser.close()

    return captured


# ─── SERIES SCRAPER ──────────────────────────────────────────────────────────

def scrape_series(slug, max_episodes=None, delay=1.5):
    """
    Full pipeline: series slug → metadata → all episode URLs → all streams + downloads.
    """
    url = f"{BASE}/anime/{slug}"
    r = requests.get(url, headers=HEADERS, timeout=15)
    soup = BeautifulSoup(r.text, "html.parser")

    episodes = []
    for a in soup.select("a[href*='/ver/']"):
        href = a["href"]
        ep_match = re.search(r"episodio-(\d+)", href)
        if ep_match:
            ep_url = href if href.startswith("http") else f"{BASE}{href}"
            episodes.append({"number": int(ep_match.group(1)), "url": ep_url})

    episodes = sorted(episodes, key=lambda x: x["number"])
    if max_episodes:
        episodes = episodes[:max_episodes]

    print(f"Series: {slug} | Episodes in HTML: {len(episodes)}")

    results = []
    for ep in episodes:
        print(f"\nEpisode {ep['number']}: {ep['url']}")
        data = extract_players(ep["url"])
        print(f"  Bridge: {data['bridge_method']}")
        print(f"  Players: {list(data['players'].keys())}")
        print(f"  Downloads: {list(data['downloads'].keys())}")
        results.append({**ep, **data})
        time.sleep(delay)

    return results


# ─── ENTRY POINT ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="latanime.org bridge scraper")
    parser.add_argument("--episode", help="Single episode URL to inspect")
    parser.add_argument("--series", help="Series slug to scrape all episodes")
    parser.add_argument("--max", type=int, default=3, help="Max episodes for series mode")
    parser.add_argument("--diagnose", action="store_true", help="Run full diagnostic dump")
    args = parser.parse_args()

    TEST = "https://latanime.org/ver/one-punch-man-temporada-3-episodio-12"
    target = args.episode or TEST

    if args.diagnose or not (args.episode or args.series):
        # Phase 1: find the bridge
        diagnose_episode(target)

    if args.series:
        scrape_series(args.series, max_episodes=args.max)
    elif args.episode or not args.diagnose:
        # Phase 2: extract
        print(f"\n{'='*65}")
        print("EXTRACTION RESULT")
        print('='*65)
        result = extract_players(target)
        print(f"Bridge method: {result['bridge_method']}")
        print(f"\nPlayers ({len(result['players'])}):")
        for s, u in result["players"].items():
            print(f"  {s}: {u}")
        print(f"\nDownloads ({len(result['downloads'])}):")
        for s, u in result["downloads"].items():
            print(f"  {s}: {u}")

        if result["bridge_method"] == "ajax_required":
            print("\n⚠  Player URLs are AJAX-loaded. Running Playwright fallback...")
            import asyncio
            captured = asyncio.run(extract_players_playwright(target))
            print(f"Intercepted {len(captured)} requests:")
            for c in captured:
                print(f"  {c}")
