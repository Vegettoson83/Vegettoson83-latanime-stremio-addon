import httpx
from bs4 import BeautifulSoup
import json
import re
import base64
from urllib.parse import unquote
from playwright.async_api import async_playwright

# Constants
TMDB_API_KEY = "49c4965e452d44430e00626adada2a45"
LATANIME_URL = "https://latanime.org"
TMDB_API_URL = "https://api.themoviedb.org/3"

async def scrape_latanime_anime_list(page: int = 1):
    """
    Scrapes a specific page of the latanime.org directory to get a list of anime.
    """
    directory_url = f"{LATANIME_URL}/animes?p={page}"
    anime_list = []
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(directory_url, headers=headers)
            response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        anime_links = soup.find_all('a', href=lambda href: href and '/anime/' in href)
        processed_urls = set()
        for link in anime_links:
            url = link.get('href')
            if url and url not in processed_urls and url.startswith(LATANIME_URL):
                title = link.get('title') or link.text.strip()
                if title:
                    anime_list.append({'title': title, 'url': url})
                    processed_urls.add(url)
        print(f"Found {len(anime_list)} unique anime entries on page {page}.")
        return anime_list
    except httpx.HTTPStatusError as e:
        print(f"Error fetching the URL: {e}")
        return []

async def get_tmdb_id(anime_title):
    """
    Searches TMDb for a given anime title and returns the TMDb ID.
    """
    search_url = f"{TMDB_API_URL}/search/tv"
    cleaned_title = re.sub(r'S\d+', '', anime_title, flags=re.IGNORECASE)
    cleaned_title = cleaned_title.replace('Castellano', '').replace('Latino', '').replace('Redoblaje', '')
    cleaned_title = re.sub(r'\(\d{4}\)', '', cleaned_title)
    cleaned_title = re.sub(r'\d{4}', '', cleaned_title)
    cleaned_title = cleaned_title.strip()

    params = {'api_key': TMDB_API_KEY, 'query': cleaned_title}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(search_url, params=params)
            response.raise_for_status()
        data = response.json()
        if data.get('results'):
            return data['results'][0]['id']
        return None
    except httpx.ConnectTimeout:
        print(f"TMDb search timed out for: '{cleaned_title}'")
        return None
    except httpx.HTTPStatusError as e:
        print(f"Error querying TMDb API for '{cleaned_title}': {e}")
        return None

async def get_tmdb_details(tmdb_id):
    """
    Gets details for a given TMDb ID, including poster path.
    """
    if not tmdb_id:
        return None
    details_url = f"{TMDB_API_URL}/tv/{tmdb_id}"
    params = {'api_key': TMDB_API_KEY}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(details_url, params=params)
            response.raise_for_status()
        return response.json()
    except httpx.ConnectTimeout:
        print(f"TMDb details fetch timed out for ID: {tmdb_id}")
        return None
    except httpx.HTTPStatusError as e:
        print(f"Error getting TMDb details for ID {tmdb_id}: {e}")
        return None

async def get_provider_urls_from_episode_page(episode_url: str):
    """
    Scrapes the episode page to find all base64-encoded provider URLs.
    """
    print(f"Scraping episode page: {episode_url}")
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(episode_url, headers=headers)
            response.raise_for_status()

        soup = BeautifulSoup(response.text, 'html.parser')
        provider_links = soup.find_all('a', class_='play-video')

        urls = []
        for link in provider_links:
            encoded_url = link.get('data-player')
            if encoded_url:
                try:
                    decoded_url = base64.b64decode(encoded_url).decode('utf-8')
                    urls.append(decoded_url)
                except Exception as e:
                    print(f"Could not decode base64 string '{encoded_url}': {e}")

        print(f"Found {len(urls)} provider URLs.")
        return urls
    except httpx.HTTPStatusError as e:
        print(f"Error fetching episode page {episode_url}: {e}")
        return []

async def resolve_stream_with_playwright(url: str) -> str | None:
    """
    Uses Playwright to navigate to a provider page and capture the .m3u8 stream URL.
    This function will ONLY work in an environment with Playwright's browsers installed.
    """
    print(f"Attempting to resolve stream for: {url}")
    m3u8_url = None
    browser = None
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch()
            page = await browser.new_page()

            # Listen for requests and capture the one for the master playlist
            def capture_m3u8(request):
                nonlocal m3u8_url
                if ".m3u8" in request.url:
                    print(f"Found .m3u8 URL: {request.url}")
                    m3u8_url = request.url
                    page.remove_listener("request", capture_m3u8)

            page.on("request", capture_m3u8)

            await page.goto(url, timeout=30000)
            await page.wait_for_timeout(5000)

            await browser.close()
    except Exception as e:
        print(f"Playwright failed for url {url}: {e}")
        if browser and browser.is_connected():
            await browser.close()
        return None

    return m3u8_url

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/manifest.json")
async def get_manifest():
    """Provides the addon manifest to Stremio."""
    return JSONResponse(content={
        "id": "org.latanime.addon.final",
        "version": "1.0.0",
        "name": "Latanime Final",
        "description": "Provides streams from Latanime.org by scraping providers directly.",
        "resources": ["catalog", "stream"],
        "types": ["tv"],
        "catalogs": [{"type": "tv", "id": "latanime-animes", "name": "Latanime"}]
    })

@app.get("/catalog/tv/latanime-animes.json")
async def get_catalog():
    """
    Provides the catalog of anime from Latanime.org.
    """
    print("Serving catalog...")
    metas = []
    # Scrape first page for performance. In a real addon, this would be cached.
    anime_list = await scrape_latanime_anime_list(page=1)
    if not anime_list:
        return JSONResponse(content={"metas": []})

    for anime in anime_list:
        slug = anime['url'].split('/')[-1]
        tmdb_id = await get_tmdb_id(anime['title'])
        details = await get_tmdb_details(tmdb_id) if tmdb_id else None

        meta_obj = {
            "id": slug,
            "type": "tv",
            "name": anime['title'].split("Castellano")[0].split("Latino")[0].strip(),
            "poster": None,
            "description": ""
        }
        if details:
            meta_obj["name"] = details.get('name', meta_obj["name"])
            meta_obj["poster"] = f"https://image.tmdb.org/t/p/w500{details.get('poster_path')}" if details.get('poster_path') else None
            meta_obj["description"] = details.get('overview', '')
        metas.append(meta_obj)

    return JSONResponse(content={"metas": metas})

@app.get("/stream/{media_type}/{stremio_id}.json")
async def get_stream(media_type: str, stremio_id: str):
    """Provides stream information for a selected item."""
    print(f"Stream requested for: {stremio_id}")
    try:
        slug, season, episode = stremio_id.split(':')
    except ValueError:
        return JSONResponse(content={"streams": []}, status_code=400)

    episode_url = f"https://latanime.org/ver/{slug}-episodio-{episode}"
    provider_urls = await get_provider_urls_from_episode_page(episode_url)

    if not provider_urls:
        return JSONResponse(content={"streams": []})

    for url in provider_urls:
        stream_url = await resolve_stream_with_playwright(url)
        if stream_url:
            print(f"Successfully resolved stream: {stream_url}")
            return JSONResponse(content={"streams": [{"url": stream_url, "title": "Resolved Stream"}]})

    print("Could not resolve a direct stream from any provider.")
    return JSONResponse(content={"streams": []})
