const manifest = {
    id: 'org.latanime.addon',
    version: '1.1.0',
    name: 'Latanime',
    description: 'Addon to watch anime from latanime.org',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series', 'movie', 'anime'],
    idPrefixes: ['latanime-'],
    catalogs: [
        {
            type: 'series',
            id: 'latanime-latest',
            name: 'Latanime Latest',
            extra: [{ name: 'search', isRequired: false }]
        }
    ]
};

module.exports = manifest;
