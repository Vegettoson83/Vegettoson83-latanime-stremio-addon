
import express from 'express';
import * as workerModule from './index.js';
import { Readable } from 'stream';

const app = express();
const PORT = process.env.PORT || 3000;

// @ts-ignore
const worker: any = (workerModule as any).default || workerModule;

app.all('*', async (req, res) => {
  const url = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);

  const env = {
    TMDB_KEY: process.env.TMDB_KEY || "",
    BRIDGE_URL: process.env.BRIDGE_URL || "http://localhost:3001",
    BRIDGE_TOKEN: process.env.BRIDGE_TOKEN || "latanime-secret-token",
    MFP_URL: process.env.MFP_URL || "",
    MFP_PASSWORD: process.env.MFP_PASSWORD || "latanime",
    SAVEFILES_KEY: process.env.SAVEFILES_KEY || "",
    STREAM_CACHE: undefined
  };

  const ctx = {
    waitUntil: (p: Promise<any>) => p,
    passThroughOnException: () => {},
    props: {}
  };

  try {
    const request = new Request(url.toString(), {
      method: req.method,
      headers: new Headers(req.headers as any),
      // @ts-ignore
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req
    });

    const response = await worker.fetch(request, env, ctx);

    res.status(response.status);
    response.headers.forEach((value: string, key: string) => {
      res.set(key, value);
    });

    if (response.body) {
      Readable.fromWeb(response.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (e: any) {
    console.error(e);
    if (!res.headersSent) {
      res.status(500).send(e.message);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Addon shim listening on port ${PORT}`);
});
