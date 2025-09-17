import requests
from bs4 import BeautifulSoup
import requests
from bs4 import BeautifulSoup
import json
import re
import base64
from urllib.parse import unquote

# Constants
TMDB_API_KEY = "49c4965e452d44430e00626adada2a45"
LATANIME_URL = "https://latanime.org"
TMDB_API_URL = "https://api.themoviedb.org/3"
# No longer needed for vidsrc.me
# VIDSRC_KEY = "WXrUARXb1aDLaZjI"
# def decode_url(...):

def scrape_latanime_anime_list(page: int = 1):
    """
    Scrapes a specific page of the latanime.org directory to get a list of anime.
    Returns a list of dictionaries, each with 'title' and 'url'.
    """
    directory_url = f"{LATANIME_URL}/animes?p={page}"
    anime_list = []
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    try:
        print(f"Fetching anime list from page {page}: {directory_url}")
        response = requests.get(directory_url, headers=headers)
        response.raise_for_status()  # Raise an exception for bad status codes

        soup = BeautifulSoup(response.text, 'html.parser')

        # Based on the site structure, anime are in <a> tags within divs with class 'col-6'
        # A more specific selector can be constructed if needed, but this is a good start.
        # Let's find all links whose href contains '/anime/'
        anime_links = soup.find_all('a', href=lambda href: href and '/anime/' in href)

        processed_urls = set()
        for link in anime_links:
            url = link.get('href')
            if url and url not in processed_urls:
                # The title is usually in a nested div or as the link's text
                title = link.get('title') or link.text.strip()
                if title:
                    anime_list.append({'title': title, 'url': url})
                    processed_urls.add(url)

        print(f"Found {len(anime_list)} unique anime entries on page {page}.")
        return anime_list

    except requests.exceptions.RequestException as e:
        print(f"Error fetching the URL: {e}")
        return None

def scrape_all_pages(max_pages=5): # Default to 5 pages for testing
    """
    Scrapes all pages of the anime directory and returns a complete list.
    """
    all_anime = []
    for page_num in range(1, max_pages + 1):
        print(f"\n--- Scraping Page {page_num} ---")
        page_results = scrape_latanime_anime_list(page=page_num)
        if not page_results:
            print(f"No results on page {page_num}, stopping.")
            break
        all_anime.extend(page_results)

    print(f"\n--- Finished Scraping. Found a total of {len(all_anime)} anime. ---")
    return all_anime

def get_tmdb_id(anime_title):
    """
    Searches TMDb for a given anime title and returns the TMDb ID.
    """
    search_url = f"{TMDB_API_URL}/search/tv"
    # More aggressive cleaning
    cleaned_title = re.sub(r'S\d+', '', anime_title, flags=re.IGNORECASE)
    cleaned_title = cleaned_title.replace('Castellano', '').replace('Latino', '').replace('Redoblaje', '')
    cleaned_title = re.sub(r'\(\d{4}\)', '', cleaned_title) # Remove year in parentheses
    cleaned_title = re.sub(r'\d{4}', '', cleaned_title) # Remove year without parentheses
    cleaned_title = cleaned_title.strip()

    params = {
        'api_key': TMDB_API_KEY,
        'query': cleaned_title
    }
    try:
        print(f"Searching TMDb for: '{cleaned_title}'")
        response = requests.get(search_url, params=params)
        response.raise_for_status()

        data = response.json()
        if data.get('results'):
            # Assume the first result is the most relevant one
            tmdb_id = data['results'][0]['id']
            print(f"Found TMDb ID: {tmdb_id}")
            return tmdb_id
        else:
            print(f"No results found on TMDb for '{cleaned_title}'.")
            return None

    except requests.exceptions.RequestException as e:
        print(f"Error querying TMDb API: {e}")
        return None

def get_tmdb_details(tmdb_id):
    """
    Gets details for a given TMDb ID, including poster path.
    """
    if not tmdb_id:
        return None
    details_url = f"{TMDB_API_URL}/tv/{tmdb_id}"
    params = {'api_key': TMDB_API_KEY}
    try:
        response = requests.get(details_url, params=params)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"Error getting TMDb details: {e}")
        return None

def get_imdb_id(tmdb_id):
    """
    Gets the IMDb ID for a given TMDb ID.
    """
    if not tmdb_id:
        return None

    external_ids_url = f"{TMDB_API_URL}/tv/{tmdb_id}/external_ids"
    params = {
        'api_key': TMDB_API_KEY
    }
    try:
        print(f"Fetching external IDs for TMDb ID: {tmdb_id}")
        response = requests.get(external_ids_url, params=params)
        response.raise_for_status()

        data = response.json()
        if data.get('imdb_id'):
            imdb_id = data['imdb_id']
            print(f"Found IMDb ID: {imdb_id}")
            return imdb_id
        else:
            print("IMDb ID not found in TMDb response.")
            return None

    except requests.exceptions.RequestException as e:
        print(f"Error querying TMDb for external IDs: {e}")
        return None

def get_stream_url(imdb_id, season, episode):
    """
    Uses the vidsrc.me logic to get a provider URL.
    """
    if not imdb_id:
        return None

    embed_url = f"https://vidsrc.me/embed/{imdb_id}/{season}-{episode}"
    headers = {'Referer': embed_url}

    try:
        print(f"Fetching vidsrc.me page: {embed_url}")
        response = requests.get(embed_url, headers=headers)
        response.raise_for_status()

        soup = BeautifulSoup(response.text, 'html.parser')

        server_divs = soup.find_all('div', class_='server')
        if not server_divs:
            print("Could not find server divs on vidsrc.me page.")
            return None

        # For now, just try the first provider
        first_provider = server_divs[0]
        data_hash = first_provider.get('data-hash')
        print(f"Found data-hash: {data_hash}")

        rcp_url = f"https://vidsrc.stream/rcp/{data_hash}"
        print(f"Fetching RCP page: {rcp_url}")
        rcp_response = requests.get(rcp_url, headers={'Referer': embed_url})
        rcp_response.raise_for_status()

        html_content = rcp_response.text

        # New logic: search for the encoded URL in the script tag
        match = re.search(r"src: '//vidsrc.net/srcrcp/([^']*)'", html_content)

        if match:
            encoded_part = match.group(1)
            final_url = f"https://vidsrc.net/srcrcp/{encoded_part}"
            print(f"Found provider URL via regex: {final_url}")
            return final_url
        else:
            print("Could not find the encoded source URL in the RCP page script.")
            return None

    except requests.exceptions.RequestException as e:
        print(f"Error getting stream URL from vidsrc.me: {e}")
        return None

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# Allow CORS for Stremio web app
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
    manifest = {
        "id": "org.latanime.addon",
        "version": "1.0.0",
        "name": "Latanime Scraper",
        "description": "Provides streams from Latanime.org",
        "resources": ["catalog", "stream"],
        "types": ["tv"],
        "catalogs": [
            {
                "type": "tv",
                "id": "latanime-animes",
                "name": "Latanime"
            }
        ]
    }
    return JSONResponse(content=manifest)

@app.get("/catalog/tv/latanime-animes.json")
async def get_catalog():
    """
    Provides the catalog of anime from Latanime.org.
    For performance, this only scrapes the first page.
    """
    print("Serving catalog...")
    metas = []

    anime_list = scrape_latanime_anime_list(page=1)
    if not anime_list:
        return JSONResponse(content={"metas": []})

    for anime in anime_list:
        tmdb_id = get_tmdb_id(anime['title'])
        if tmdb_id:
            imdb_id = get_imdb_id(tmdb_id)
            details = get_tmdb_details(tmdb_id)

            if imdb_id and details:
                metas.append({
                    "id": imdb_id,
                    "type": "tv",
                    "name": details.get('name', 'N/A'),
                    "poster": f"https://image.tmdb.org/t/p/w500{details.get('poster_path')}" if details.get('poster_path') else None,
                    "description": details.get('overview', '')
                })

    return JSONResponse(content={"metas": metas})

@app.get("/stream/{media_type}/{stremio_id}.json")
async def get_stream(media_type: str, stremio_id: str):
    """Provides stream information for a selected item."""
    print(f"Stream requested for: {stremio_id}")
    try:
        imdb_id, season, episode = stremio_id.split(':')
    except ValueError:
        return JSONResponse(content={"streams": []})

    # Get the provider URL
    provider_url = get_stream_url(imdb_id, season, episode)

    if provider_url:
        # For now, we return the provider URL directly.
        # A full implementation would resolve this to a .m3u8 file.
        return JSONResponse(content={
            "streams": [{"url": provider_url, "title": "Latanime Source"}]
        })

    return JSONResponse(content={"streams": []})
