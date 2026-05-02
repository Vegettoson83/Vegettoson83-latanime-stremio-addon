
import express from 'express';
import worker from './index.js';

const app = express();
const port = process.env.PORT || 3000;

app.all('*', async (req, res) => {
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  // Construct a standard Fetch Request object from Express Request
  const request = new Request(url, {
    method: req.method,
    headers: new Headers(req.headers as any),
    // @ts-ignore
    body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? req : undefined,
    // @ts-ignore - duplex is required for streaming bodies in Node.js
    duplex: 'half',
  });

  // Mock Worker Environment
  const env = {
    TMDB_KEY: process.env.TMDB_KEY || "",
    BRIDGE_URL: process.env.BRIDGE_URL || "https://latanime-bridge.onrender.com",
    MFP_URL: process.env.MFP_URL || "",
    MFP_PASSWORD: process.env.MFP_PASSWORD || "latanime",
    SAVEFILES_KEY: process.env.SAVEFILES_KEY || "10714bycsy7sdam6brjzf",
    STREAM_CACHE: null as any, // KV not available in Node.js shim yet
  };

  // Mock ExecutionContext
  const ctx = {
    waitUntil: (promise: Promise<any>) => promise.catch(console.error),
    passThroughOnException: () => {},
    props: {},
  };

  try {
    const response = await worker.fetch(request, env, ctx);

    // Copy status and headers
    res.status(response.status);
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    // Stream the body back
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (err: any) {
    console.error('Worker error:', err);
    res.status(500).send(err.message || 'Internal Server Error');
  }
});

app.listen(port, () => {
  console.log(`Addon server listening at http://localhost:${port}`);
});
