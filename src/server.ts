import express from 'express';
import { Readable } from 'node:stream';
// @ts-ignore
import workerModule from './index.js';

const app = express();
const port = process.env.PORT || 3000;

// Resolve the worker handler
const worker: any = (workerModule as any).default || workerModule;

app.all('*', async (req, res) => {
  try {
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    // Construct the standard Request object
    // @ts-ignore - Express req can be cast for the body Init
    const request = new Request(url, {
      method: req.method,
      headers: new Headers(req.headers as any),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : (req as any),
      // @ts-ignore
      duplex: 'half'
    });

    const env = {
      TMDB_KEY: process.env.TMDB_KEY || "",
      BRIDGE_URL: process.env.BRIDGE_URL || "",
      MFP_URL: process.env.MFP_URL || "",
      MFP_PASSWORD: process.env.MFP_PASSWORD || "",
      SAVEFILES_KEY: process.env.SAVEFILES_KEY || "",
      STREAM_CACHE: null // KV not available in shim, uses in-memory/direct fetch
    };

    // Mock ExecutionContext
    const ctx = {
      waitUntil: (promise: Promise<any>) => promise.catch(console.error),
      passThroughOnException: () => {},
      props: {}
    };

    const response = await worker.fetch(request, env, ctx);

    // Forward status and headers
    res.status(response.status);
    response.headers.forEach((value: string, key: string) => {
      res.setHeader(key, value);
    });

    if (response.body) {
      // Use Readable.fromWeb to prevent OOM and support progressive playback
      Readable.fromWeb(response.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error('Shim Error:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(port, () => {
  console.log(`Addon shim listening at http://localhost:${port}`);
});
