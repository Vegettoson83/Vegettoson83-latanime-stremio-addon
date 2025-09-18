import httpx
from bs4 import BeautifulSoup
import json
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

# Constants
CINEBY_URL = "https://www.cineby.app"

# --- Data Fetching Logic ---
async def get_next_data(url: str):
    """
    Fetches a URL and extracts the __NEXT_DATA__ JSON blob.
    """
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()

        soup = BeautifulSoup(response.text, 'html.parser')
        next_data_script = soup.find('script', id='__NEXT_DATA__')

        if next_data_script:
            return json.loads(next_data_script.string)
        else:
            print(f"Could not find __NEXT_DATA__ script tag on {url}.")
            return None
    except Exception as e:
        print(f"Error processing URL {url}: {e}")
        return None

# --- FastAPI App ---
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Endpoints ---
@app.get("/manifest.json")
async def get_manifest():
    """Provides the addon manifest to Stremio."""
    return JSONResponse(content={
        "id": "org.cineby.addon",
        "version": "1.0.0",
        "name": "Cineby",
        "description": "Stremio addon for Cineby.app, providing content from their homepage.",
        "resources": ["catalog", "stream"],
        "types": ["movie", "tv"],
        "catalogs": [
            {"type": "movie", "id": "topratedmovie", "name": "Top Rated Movies"},
            {"type": "tv", "id": "topratedtv", "name": "Top Rated TV"}
        ],
        "idPrefixes": ["tmdb:"]
    })

@app.get("/catalog/{media_type}/{catalog_id}.json")
async def get_catalog(media_type: str, catalog_id: str):
    """Provides the catalog of content for a given type and ID."""
    print(f"Catalog requested for: {media_type} - {catalog_id}")
    metas = []

    data = await get_next_data(CINEBY_URL)
    if not data or 'props' not in data or 'pageProps' not in data['props']:
        return JSONResponse(content={"metas": []})

    page_props = data['props']['pageProps']

    # Find the correct section based on catalog_id
    section_to_use = None
    for section in page_props.get('defaultSections', []):
        if section.get('name') == catalog_id:
            section_to_use = section
            break

    if not section_to_use:
        return JSONResponse(content={"metas": []})

    for item in section_to_use.get('movies', []):
        if item.get('mediaType') == media_type:
            metas.append({
                "id": f"tmdb:{item.get('id')}",
                "type": item.get('mediaType'),
                "name": item.get('title'),
                "poster": item.get('poster'),
                "description": item.get('description')
            })

    return JSONResponse(content={"metas": metas})

@app.get("/stream/{media_type}/{stremio_id}.json")
async def get_stream(media_type: str, stremio_id: str):
    """Provides stream information for a selected item."""
    print(f"Stream requested for: {stremio_id}")
    try:
        # Stremio ID format is tmdb:id or tmdb:id:season:episode
        parts = stremio_id.split(':')
        if len(parts) < 2:
            raise ValueError("Invalid Stremio ID")

        tmdb_id = parts[1]
        # Construct the URL to the media page on cineby
        media_url = f"{CINEBY_URL}/{media_type}/{tmdb_id}"

        data = await get_next_data(media_url)
        if not data or 'props' not in data or 'pageProps' not in data['props']:
            return JSONResponse(content={"streams": []})

        # This path is a guess based on common Next.js structures and needs to be verified.
        page_data = data['props']['pageProps'].get('data', {})
        sources = page_data.get('sources', [])

        if not sources:
            print(f"No sources found in __NEXT_DATA__ for {media_url}")
            return JSONResponse(content={"streams": []})

        # Assuming 'sources' is a list of dictionaries with a 'file' key
        streams = [{"url": src.get('file'), "title": f"Source {i+1}"} for i, src in enumerate(sources) if src.get('file')]
        return JSONResponse(content={"streams": streams})

    except Exception as e:
        print(f"Error processing stream request for {stremio_id}: {e}")
        return JSONResponse(content={"streams": []})
