const manifest = {
    "id": "org.latanime.stremio",
    "version": "1.0.4",
    "name": "Latanime",
    "description": "Stremio addon for latanime.org",
    "icon": "https://latanime.org/public/img/logito.png",
    "resources": ["catalog", "stream", "meta"],
    "types": ["series"],
    "catalogs": [
        {
            "type": "series",
            "id": "latanime-series",
            "name": "Latanime",
            "extra": [
                { "name": "search", "isRequired": false },
                { "name": "skip", "isRequired": false }
            ]
        },
        {
            "type": "series",
            "id": "latanime-new",
            "name": "Nuevas Series"
        }
    ],
    "idPrefixes": ["latanime-"]
};

module.exports = manifest;
