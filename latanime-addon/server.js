#!/usr/bin/env node const express = require('express'); const cors = require('cors');

const PORT = process.env.PORT || 7000;

// Load the addon let addonInterface; try { addonInterface = require("./addon"); console.log("✅ Addon loaded successfully"); console.log("✅ Manifest:", addonInterface.manifest.name); } catch (error) { console.error("❌ Failed to load addon:", error.message); process.exit(1); }

// Create Express app const app = express();

// Enable CORS for all requests app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'] }));

// Parse JSON app.use(express.json());

// Add request logging app.use((req, res, next) => { console.log([${new Date().toISOString()}] ${req.method} ${req.url}); next(); });

// Health check endpoint app.get('/health', (req, res) => { res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'latanime-addon' }); });

// Manifest endpoint app.get('/manifest.json', (req, res) => { res.json(addonInterface.manifest); });

// Catalog endpoint app.get('/catalog/:type/:id.json', async (req, res) => { try { const { type, id } = req.params; console.log(📚 Catalog: ${type}/${id}); const result = await addonInterface.get({ resource: 'catalog', type, id, extra: req.query }); res.json(result); } catch (error) { console.error('❌ Catalog error:', error); res.status(500).json({ error: error.message }); } });

// Meta endpoint
app.get('/meta/:type/:id.json', async (req, res) => { try { const { type, id } = req.params; console.log(📄 Meta: ${type}/${id}); const result = await addonInterface.get({ resource: 'meta', type, id, extra: req.query }); res.json(result); } catch (error) { console.error('❌ Meta error:', error); res.status(500).json({ error: error.message }); } });

// Stream endpoint app.get('/stream/:type/:id.json', async (req, res) => { try { const { type, id } = req.params; console.log(🎬 Stream: ${type}/${id}); const result = await addonInterface.get({ resource: 'stream', type, id, extra: req.query }); res.json(result); } catch (error) { console.error('❌ Stream error:', error); res.status(500).json({ error: error.message }); } });

// Catch all other requests app.get('*', (req, res) => { res.status(404).json({ error: 'Not found' }); });

// Start server app.listen(PORT, () => { console.log(🚀 Latanime addon running on port ${PORT}); console.log(📺 Manifest: http://localhost:${PORT}/manifest.json); console.log(❤️ Health: http://localhost:${PORT}/health); console.log(🔗 Add to Stremio: http://localhost:${PORT}/manifest.json); });
