import express from 'express';
// @ts-ignore
import workerModule from './index.js';

const app = express();
const port = process.env.PORT || 3000;

// ESM compatibility: handle both default and module object
const worker: any = (workerModule as any).default || workerModule;

app.all('*', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['host'];
  const url = `${protocol}://${host}${req.originalUrl}`;

  // Create a standard Request object compatible with the Worker fetch handler
  const request = new Request(url, {
    method: req.method,
    headers: req.headers as any,
    // @ts-ignore
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
    // @ts-ignore
    duplex: 'half'
  });

  const env = {
    TMDB_KEY: process.env.TMDB_KEY || "",
    BRIDGE_URL: process.env.BRIDGE_URL || "https://latanime-bridge.onrender.com",
    MFP_URL: process.env.MFP_URL || "",
    MFP_PASSWORD: process.env.MFP_PASSWORD || "latanime",
    SAVEFILES_KEY: process.env.SAVEFILES_KEY || "10714bycsy7sdam6brjzf",
    STREAM_CACHE: undefined as any
  };

  const ctx = {
    waitUntil: (p: Promise<any>) => {},
    passThroughOnException: () => {},
    props: {}
  };

  try {
    const response = await worker.fetch(request, env, ctx);

    res.status(response.status);
    response.headers.forEach((value: string, key: string) => {
      res.setHeader(key, value);
    });

    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (e: any) {
    console.error(`[server] Error handling ${req.method} ${req.url}:`, e);
    res.status(500).send(e.message || "Internal Server Error");
  }
});

app.listen(port, () => {
  console.log(`Addon server listening on port ${port}`);
});
